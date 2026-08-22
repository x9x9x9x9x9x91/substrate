import { useEffect, useRef, useState } from "react";
import type { NoteMeta, PropValue, SchemaConfig } from "../lib/types";
import {
  vaultCreate,
  vaultList,
  vaultRead,
  vaultSetProp,
  vaultWriteBody,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { dashboardSheets } from "../lib/dashboardSheets";
import { useFxRates } from "./useFx";
import { DashHead, DashPrintButton } from "./DashHead";
import { KIND_API, type KindEnableRecord, type KindFileMeta, type KindState } from "../lib/kinds";
import { ACCENT_NAMES } from "../lib/styletokens";
import {
  kindFileUrl,
  kindManifestNotice,
  kindReview,
  kindRuntimeCard,
  kindSchemeOrigin,
  kindStateCard,
  shouldTrustReenable,
  type KindCard,
} from "../lib/kindpane";
import { armKindSandbox, hostSurface, watchKindDom, type KindSandbox } from "../lib/kindSandbox";
import KindReviewCard from "./KindReviewCard";
import { kindsEnable } from "../lib/ipc";
import { invalidateKindBundles } from "../hooks/useKindBundles";
import { DashAlert } from "./DashNotice";
import { thrownText } from "../lib/errtext";

/* The host for a vault-resident dashboard kind (vault-format §5.8).

   What this component is responsible for, and the kind is not: the head (title,
   state dot, source button, Print), deciding whether the code may run at all,
   loading it, handing it a ctx, and turning every possible failure into a card
   that still has a head. The kind gets an empty element and owns what is
   inside it — no React, no framework, no styling contract beyond `ctx.css`.

   The pane never blanks and never falls through to the body scan. A kind
   that can't run says why, naming itself and the file.

   The one failure this pane cannot turn into a card: a throw from code the
   kind scheduled and the pane never awaited — a timer callback, an unhandled
   promise rejection, a listener firing later. Nothing here is on that stack,
   so it lands in the console like any other page error and the kind's own
   output stays as it was. Catching it would take a global handler, which
   would attribute every page-wide error to whichever kind happened to be
   mounted. What IS covered: the import, the module shape, and the synchronous
   body of mount() — the failures that mean the kind never got going.

   Three ways a kind used to take the pane down with it, all contained here
   rather than left to the kind's good manners:

   - mount() never settling. An async mount that awaits something that never
     arrives left the pane holding an empty div forever, with no spinner and
     no message — indistinguishable from a kind that drew nothing on purpose.
     A watchdog turns that wait into a card once it has plainly stalled.
   - writing outside the element it was handed. The host owns the head and
     the frame; a kind that appends to document.body or empties its parent
     blanked the pane with the damage still on screen. Its mount call is
     watched, what it did outside its own element is put back, and it gets a
     card naming what it touched (`kindSandbox.ts`).
   - leaving timers and window listeners running. Those are reclaimed at
     unmount by the same module — see its header for what is and is not
     attributable, and vault-format §5.8 for what a kind is still told to
     clean up itself. */

/** How long a mount() may be in flight, having drawn nothing, before the pane
    stops waiting and says so. Generous on purpose: a kind that reads a large
    sheet over IPC on a cold vault is doing real work, and a watchdog that
    fires on slow-but-fine is worse than the blank it replaces. Well short of
    the point where a person concludes the app is broken. */
const MOUNT_STALL_MS = 5000;

/** A duck-typed promise check — a kind may return any thenable, and one from
    another realm fails `instanceof Promise`. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof (v as { then?: unknown } | null | undefined)?.then === "function";
}

/** What the pane needs from `DashboardBody`. A subset of DashboardPaneProps,
    spelled out rather than imported so the kind surface can't quietly grow
    access to whatever a future dashboard prop carries. */
export interface CustomKindPaneProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  vaultEpoch: number;
  schema: SchemaConfig;
  onOpenSource: (path: string) => void;
  onMutated: () => void;
  onFollowLink?: (name: string) => void;
  onToast?: (msg: string, action?: { label: string; run: () => void }) => void;
  /** the bundle folder name — also the kind id and its URL segment */
  id: string;
  /** the hash of the bytes on disk, which cache-busts the module URL */
  hash: string;
  /** what `resolveKindState` made of this bundle plus its consent record */
  state: KindState;
  /** the consent record itself, when there is one. The state says whether the
      kind runs; only the record carries the standing "trust updates" rider. */
  record?: KindEnableRecord;
  /** the files the hash covers, for the review's file list. Absent on rows
      from a build older than the review flow. */
  files?: KindFileMeta[];
}

/** The class names a kind may render through — the app's voice, so a kind
    follows the theme without shipping a stylesheet. Identity mapping today;
    the indirection is the point, because it lets the app rename a class
    without breaking every installed kind. */
const KIND_CSS: Record<string, string> = Object.freeze({
  "dash-metrics": "dash-metrics",
  "dash-metric": "dash-metric",
  "dash-metric-sub": "dash-metric-sub",
  "dash-label": "dash-label",
  "dash-value": "dash-value",
  "dash-sub": "dash-sub",
  "dash-hero": "dash-hero",
  "dash-table": "dash-table",
  "dash-card": "dash-card",
  "dash-cards": "dash-cards",
  "dash-section-label": "dash-section-label",
  "dash-link": "dash-link",
  "dash-foot": "dash-foot",
});

/** The kind's half of the contract: a default export with `mount`. */
interface KindModule {
  default?: { mount?: (el: Element, ctx: unknown) => void | (() => void) };
}

export default function CustomKindPane(props: CustomKindPaneProps) {
  const { id, hash, state } = props;
  const host = useRef<HTMLDivElement | null>(null);
  /* A runtime failure is state, not a thrown render: the head has to survive
     it, so the mount effect stores a card here instead of blowing up. */
  const [runtime, setRuntime] = useState<KindCard | null>(null);
  /* The kind's own state dot (`ctx.setState`), null while it stays quiet. */
  const [kindState, setKindState] = useState<{ color?: string; label: string } | null>(null);
  /* What the app refused to do for the kind, in the order it refused it. A
     ctx guard rejecting a write it did not permit, or a sheet that isn't
     there, used to reach an author only through the console — the kind draws
     whatever it drew before the call and the pane says nothing, so the reading
     on screen is "my code did nothing" rather than "the app said no, here is
     why". The throw still happens; this is the surface it was missing.
     Deduped, because a refusal inside an onChange handler repeats with every
     vault change. */
  const [refusals, setRefusals] = useState<string[]>([]);

  const { fx } = useFxRates();
  const fxRef = useRef(fx);
  fxRef.current = fx;
  /* onChange subscribers, and the note snapshot ctx.note points at. Both live
     in refs because the kind holds the ctx object across renders: mount runs
     once, and every later vault change updates these in place and fires the
     callbacks. Re-mounting per change would throw away scroll, focus and
     whatever else the kind was holding. */
  const subs = useRef(new Set<() => void>());
  const note = useRef({ path: props.meta.path, title: props.meta.title, props: props.meta.props, body: "" });
  /* Latest host callbacks, so a ctx captured at mount never calls a stale one. */
  const live = useRef(props);
  live.current = props;

  /* The mounted kind's containment surface, shared with the vault-change
     effect below so a timer armed from an onChange handler is reclaimed with
     everything else. Null whenever no kind code is live. */
  const sandboxRef = useRef<KindSandbox | null>(null);

  const runnable = state.state === "enabled";
  const entry = state.state === "invalid" ? null : state.manifest.entry;
  const style = state.state === "invalid" ? undefined : state.manifest.style;

  useEffect(() => {
    /* Reset BEFORE any bail-out. A re-run means a different bundle — an agent
       rewrote the code (new hash), or the user enabled it — and the previous
       run's runtime card must not outlive the run that produced it. Guarding
       this behind the host lookup is how a failed kind used to get stuck
       failing until the user navigated away and back. */
    setRuntime(null);
    setKindState(null);
    setRefusals([]);
    if (!runnable || !entry) return;
    const el = host.current;
    if (!el) return;

    let dead = false;
    let cleanup: (() => void) | undefined;
    let styleEl: HTMLStyleElement | null = null;
    /* Armed before any of the kind's code can run and released in teardown:
       what it registers on the window goes away with its pane. */
    const sandbox = armKindSandbox();
    sandboxRef.current = sandbox;
    let stall: number | undefined;
    /* The element the kind owns outright, tracked out here so both exits —
       failure and unmount — can take exactly it away again. */
    let own: HTMLElement | null = null;

    /* Everything this run put into the world, removed in one place: the kind's
       own cleanup, its onChange subscriptions, the injected stylesheet and the
       element it drew into. Both exits go through here, so a kind that fails
       after its mount() started having effects leaves nothing running. */
    const teardown = () => {
      subs.current.clear();
      if (stall !== undefined) window.clearTimeout(stall);
      stall = undefined;
      try {
        // Inside the sandbox: a kind whose cleanup arms one last timer does
        // not get to outlive its own teardown by doing so.
        sandbox.run(() => cleanup?.());
      } catch (e) {
        // A kind that throws on the way out must not take the app's teardown
        // with it — it is going away regardless.
        console.warn(`custom kind “${id}”: cleanup threw`, e);
      }
      // After its own cleanup has had its turn — whatever it left behind on
      // the window is cancelled here.
      sandbox.release();
      if (sandboxRef.current === sandbox) sandboxRef.current = null;
      cleanup = undefined;
      styleEl?.remove();
      styleEl = null;
      own?.remove();
      own = null;
      // Nothing from this run may reach React after it: a timer the kind
      // armed before it failed must not push a state dot for a kind that is
      // no longer running (and, on unmount, no longer mounted).
      dead = true;
    };

    /* A failure mid-life is a full stop, not just a card: tear the kind down
       first, then show why. The effect's own cleanup won't run for this — the
       deps didn't change — so anything left registered here would outlive the
       kind that registered it. */
    const failWith = (file: string, msg: string) => {
      if (dead) return;
      teardown();
      setRuntime(kindRuntimeCard(id, file, msg));
    };
    const fail = (file: string, e: unknown) => {
      // the class name earns its place here — a kind's author reading
      // "TypeError: x is not a function" learns more than from the message
      // alone. What it must not do is print a bare "null" for a throw that
      // carried no message at all.
      failWith(file, e instanceof Error ? `${e.name}: ${e.message}` : thrownText(e));
    };

    /* An async mount that never settles used to leave an empty div and
       nothing else — the pane looked like a kind that drew nothing. Past the
       point where "still working" stops being a plausible reading, the wait
       becomes a card that names the kind and the stall. Two guards keep it
       from firing on a kind that is merely slow: it settles the moment the
       promise does, and it stays quiet if the kind has drawn anything at all
       (a kind that painted and then kept loading is working, not stalled). */
    const armMountWatchdog = (p: PromiseLike<unknown>) => {
      let settled = false;
      stall = window.setTimeout(() => {
        stall = undefined;
        if (settled || dead) return;
        if (own && own.childNodes.length > 0) return;
        failWith(
          entry,
          `mount() has not finished after ${Math.round(MOUNT_STALL_MS / 1000)} seconds and nothing has been drawn — it is waiting on something that has not arrived.`,
        );
      }, MOUNT_STALL_MS);
      p.then(
        (out: unknown) => {
          settled = true;
          if (stall !== undefined) window.clearTimeout(stall);
          stall = undefined;
          /* An async mount returns its cleanup the same way a synchronous one
             does — through the resolved value — and dropping it here left
             every kind that awaits before wiring up leaking exactly what the
             sandbox cannot see. If the pane went while the promise was in
             flight, teardown has already been and gone, so the cleanup runs
             now rather than never. */
          if (typeof out !== "function") return;
          const resolved = out as () => void;
          if (!dead) {
            cleanup = resolved;
            return;
          }
          try {
            sandbox.run(() => resolved());
          } catch (e) {
            console.warn(`custom kind “${id}”: cleanup threw`, e);
          }
        },
        (e: unknown) => {
          settled = true;
          if (stall !== undefined) window.clearTimeout(stall);
          stall = undefined;
          /* A mount that rejects is a kind that failed, and it gets the card
             a kind that throws synchronously gets — leaving the pane blank
             and the reason in the console only was a failure the reader had
             no way to see. */
          fail(entry, e);
          /* Re-thrown on purpose, after the card. A rejected mount() is code
             the pane never awaited (see the header): it belongs in the
             console as the page error it has always been, and swallowing it
             here would hide the stack the kind's author needs. */
          throw e;
        },
      );
    };

    (async () => {
      try {
        const content = await vaultRead(live.current.meta.path);
        if (dead) return;
        note.current = {
          path: live.current.meta.path,
          title: live.current.meta.title,
          props: content.props,
          body: content.body,
        };
      } catch {
        // A dashboard note the app is rendering but can't read is a vault
        // problem, not a kind problem — hand the kind an empty body rather
        // than blaming its code on a card.
        note.current = { ...note.current, body: "" };
      }

      // The stylesheet is fetched and injected rather than linked so it comes
      // out again on unmount: a <link> left behind would keep restyling the
      // next dashboard. A style that fails to load is not fatal — an unstyled
      // kind still shows its data — so it only warns.
      if (style) {
        try {
          const css = await loadKindFile(id, style, hash);
          if (dead) return;
          styleEl = document.createElement("style");
          styleEl.dataset.kind = id;
          styleEl.textContent = css;
          el.appendChild(styleEl);
        } catch (e) {
          console.warn(`custom kind “${id}”: ${style} failed to load`, e);
        }
      }

      let mod: KindModule;
      try {
        mod = await importKindModule(id, entry, hash);
      } catch (e) {
        fail(entry, e);
        return;
      }
      if (dead) return;

      const mount = mod?.default?.mount;
      if (typeof mount !== "function") {
        fail(entry, new Error("no default export with a mount(el, ctx) function"));
        return;
      }

      // The element the kind owns outright — its own child, so the injected
      // <style> and anything the host adds later stay outside it.
      own = document.createElement("div");
      own.className = "kind-body";
      el.appendChild(own);

      const drawn = own;
      /* ctx.setState is dead-guarded the same way fail() is: a kind that
         fires it from a timer after it was torn down (or after the pane
         unmounted) must not set state on a component that is done with it. */
      const pushState = (s: { color?: string; label: string } | null) => {
        if (dead) return;
        setKindState(s);
      };
      /* Dead-guarded like pushState, and for the same reason: a refusal can
         arrive from a promise the kind armed before it was torn down. */
      const pushRefusal = (msg: string) => {
        if (dead) return;
        setRefusals((prev) => (prev.includes(msg) ? prev : [...prev, msg]));
      };
      const ctx = hostSurface(
        makeCtx(drawn, id, subs.current, note, fxRef, live, pushState, pushRefusal),
        sandbox,
      );
      /* The whole synchronous mount, watched: single-threaded means anything
         the DOM sees between these two lines is this kind's doing. */
      const watch = watchKindDom(drawn);
      let out: void | (() => void);
      try {
        out = sandbox.run(() => mount(drawn, ctx));
      } catch (e) {
        watch.stop();
        fail(entry, e);
        return;
      }
      const escaped = watch.stop();
      if (escaped) {
        // The DOM is already back the way it was; the kind is stopped rather
        // than left half-drawn next to chrome it tried to replace.
        failWith(entry, escaped.summary);
        return;
      }
      if (typeof out === "function") cleanup = out;
      else if (isThenable(out)) armMountWatchdog(out);
      if (dead) {
        // unmounted while mount() was running — honour the teardown anyway
        teardown();
      }
    })();

    return () => {
      dead = true;
      teardown();
    };
    // The bundle hash is in the dependency list on purpose: re-enabling a kind
    // whose code an agent rewrote is a different bundle, and it re-mounts.
  }, [id, hash, entry, style, runnable, props.meta.path]);

  /* Vault changes are a redraw signal, not a re-mount (§5.8). Refresh the
     note snapshot ctx.note points at, then let the kind decide what to do. */
  const firstEpoch = useRef(props.vaultEpoch);
  useEffect(() => {
    if (!runnable) return;
    if (props.vaultEpoch === firstEpoch.current) return;
    let gone = false;
    vaultRead(props.meta.path)
      .then((c) => {
        if (gone) return;
        note.current = { ...note.current, props: c.props, body: c.body };
      })
      .catch(() => {
        /* keep the last good snapshot */
      })
      .finally(() => {
        if (gone) return;
        const sb = sandboxRef.current;
        for (const cb of [...subs.current]) {
          try {
            // Same attribution as mount: a redraw handler that re-arms a
            // timer is still the kind arming it.
            if (sb) sb.run(() => cb());
            else cb();
          } catch (e) {
            console.warn(`custom kind “${id}”: onChange handler threw`, e);
          }
        }
      });
    return () => {
      gone = true;
    };
  }, [props.vaultEpoch, props.meta.path, runnable, id]);

  /* The agent-iteration loop: a kind the user marked "trust updates" re-enables
     itself when its bytes change here, because a person editing their own kind
     should not re-consent on every save. Nothing else takes this path — a first
     consent never can (`shouldTrustReenable` refuses it), and the rider only
     exists because the user ticked it on this kind in this vault.

     The attempted hash is remembered so a refusal can't loop: `kinds_enable`
     failing leaves the drift card up, and the next render finds this hash
     already tried. */
  const trusted = shouldTrustReenable(state, props.record);
  const triedHash = useRef<string | null>(null);
  const [trustedEnableFailed, setTrustedEnableFailed] = useState(false);
  useEffect(() => {
    if (!trusted || triedHash.current === hash) return;
    triedHash.current = hash;
    setTrustedEnableFailed(false);
    kindsEnable(id, hash)
      .then(() => invalidateKindBundles())
      .catch((e) => {
        console.warn(`custom kind “${id}”: trusted re-enable failed`, e);
        setTrustedEnableFailed(true);
      });
  }, [trusted, id, hash]);

  const card = runtime ?? kindStateCard(id, state);
  /* Not a failure — the kind loaded and runs. It belongs on the pane anyway:
     an ignored key is silent by construction, so the author's only other
     clue is that whatever it was meant to set never happened. */
  const manifestNotice = state.state === "invalid" ? null : kindManifestNotice(id, state.manifest);
  const head = card ? { label: card.label } : kindState;
  /* The review replaces the card rather than joining it: the review carries the
     same headline sentence, and showing both would say it twice. A state with
     no review — too-new api, broken manifest, a runtime failure — keeps the
     card, which is the whole message it has. */
  /* A trusted drift is not a question, so it is not asked: computing the
     review on the same pass that schedules the auto-enable would paint the
     full consent card — terms, file list, a live enable button — for the frame
     it takes the IPC round trip to land. The card comes back only if that
     re-enable FAILED, because then there is a decision again and the pane is
     the only place to make it. */
  const review =
    runtime || (trusted && !trustedEnableFailed)
      ? null
      : kindReview(id, state, props.files, props.record);

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={props.meta.title}
          state={head}
          actions={<DashPrintButton />}
          sourcePath={props.meta.path}
          onOpenSource={props.onOpenSource}
        />
        {review ? (
          /* No onChanged: `invalidateKindBundles` already re-reads the list
             everywhere it is on screen, and this pane's own props come from
             that list. */
          <KindReviewCard review={review} hash={hash} />
        ) : (
          card && <DashAlert>{card.message}</DashAlert>
        )}
        {manifestNotice && <DashAlert>{manifestNotice}</DashAlert>}
        {refusals.map((msg) => (
          <DashAlert key={msg}>{msg}</DashAlert>
        ))}
        {/* The host renders unconditionally, as the card's sibling rather than
            its alternative. Two reasons, both lifecycle: `host.current` stays
            live through a failure, so the next run of the mount effect — an
            agent rewrote the bundle, the user enabled it — can re-mount in
            place instead of bailing on a null ref forever; and React never
            reuses this node for the card, so the pane's own teardown can't
            reach into children React owns. It is empty whenever a card shows:
            the kind's element goes away with the failure that produced it. */}
        <div className="kind-host" ref={host} />
      </div>
    </div>
  );
}

// ---------- loading ----------

/** Read one bundle file as text.

    In the app that is a fetch over the `substrate-kind:` scheme,
    which serves only the manifest's `entry` and `style` and refuses anything
    else. In the mock/dev lane there is no scheme and no vault, so e2e seeds
    bundle text through a window hook instead. The mock branch is gated on
    `isTauri` and nothing else: the shipped CSP never sees it. */
async function loadKindFile(id: string, file: string, hash: string): Promise<string> {
  if (!isTauri) {
    const src = window.__mockKindFile?.(id, file);
    if (src === undefined) throw new Error(`no mock source for ${id}/${file}`);
    return src;
  }
  const res = await fetch(kindFileUrl(kindSchemeOrigin(navigator.userAgent), id, file, hash));
  if (!res.ok) throw new Error(`${file} could not be read (${res.status})`);
  return res.text();
}

/** Import a bundle's entry as an ES module.

    `@vite-ignore` keeps Vite from trying to resolve a runtime URL at build
    time. The `?v=<hash12>` matters more than it looks: the webview's module
    registry is keyed by URL for the page's whole lifetime, so without it an
    agent rewriting a kind mid-session would keep running the module imported
    at boot until the app relaunched. Hash-per-URL makes a rewrite a hot swap.

    The mock lane imports the same source through a blob URL — same module
    semantics, no scheme required. Blob imports are only reachable when
    `isTauri` is false (dev/e2e, no CSP); the shipped CSP allows the scheme
    and not `blob:`. */
async function importKindModule(id: string, entry: string, hash: string): Promise<KindModule> {
  if (!isTauri) {
    const src = await loadKindFile(id, entry, hash);
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    try {
      return (await import(/* @vite-ignore */ url)) as KindModule;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const url = kindFileUrl(kindSchemeOrigin(navigator.userAgent), id, entry, hash);
  return (await import(/* @vite-ignore */ url)) as KindModule;
}

// ---------- ctx ----------

/** Build the api-1 ctx (vault-format §5.8).

    Every write rides the app's own IPC wrappers, with `expected` /
    `expectedBody` REQUIRED rather than optional: the wrappers treat a missing
    guard as "write unconditionally", which is a defensible thing for the app
    to do about its own surfaces and never a defensible thing for vault-resident
    code to do to a note the user may have open. ctx is ergonomics, not a
    boundary — a kind that wants raw IPC has it; the point is that the easy
    path is the safe one. */
function makeCtx(
  el: Element,
  id: string,
  subs: Set<() => void>,
  note: { current: { path: string; title: string; props: Record<string, unknown>; body: string } },
  fx: { current: ReturnType<typeof useFxRates>["fx"] },
  live: { current: CustomKindPaneProps },
  setState: (s: { color?: string; label: string } | null) => void,
  report: (msg: string) => void,
) {
  const touched = () => live.current.onMutated();
  /* Every "the app said no" in one place, so refusing and saying so on the
     pane cannot drift apart: the throw the kind catches and the line its
     author reads are the same sentence. */
  const refuse = (msg: string) => {
    report(msg);
    return new Error(msg);
  };
  return {
    api: KIND_API,
    el,
    get note() {
      return { ...note.current, props: { ...note.current.props } };
    },
    css: KIND_CSS,
    // Mood, bounded: the same roster of names a `cards` fence or a
    // hub callout draws from, handed over so a kind can offer a choice instead
    // of inventing a hex. A kind sets `data-accent="<name>"` on a sanctioned
    // class and the app resolves the hue; an off-roster name simply doesn't
    // paint, exactly as it doesn't in a fence.
    // A COPY, like `note` above: `readonly` is compile-time only and vault code
    // is a plain ES module, so handing the live array over would let one
    // `.push()`/`.sort()` in a kind reorder the roster `typeTint()` hashes over
    // and widen `tintVar`'s membership gate app-wide until reload.
    accents: [...ACCENT_NAMES],

    notes: async (filter?: (n: NoteMeta) => boolean) => {
      const all = await vaultList();
      return filter ? all.filter(filter) : all;
    },
    read: (path: string) => vaultRead(path),
    sheet: async (title: string) => {
      const sheets = await dashboardSheets([title], live.current.vaultEpoch, fx.current);
      const got = sheets.get(title.toLowerCase());
      if (!got) throw refuse(`no sheet named “${title}”`);
      if ("error" in got) throw refuse(got.error);
      return got;
    },

    setProp: async (path: string, key: string, value: PropValue, expected: { value: PropValue }) => {
      if (!expected || typeof expected !== "object" || !("value" in expected)) {
        throw refuse("setProp requires expected: { value } — a write from a kind without that guard is a clobber");
      }
      const out = await vaultSetProp(path, key, value, expected);
      touched();
      return out;
    },
    writeBody: async (path: string, body: string, expectedBody: string) => {
      if (typeof expectedBody !== "string") {
        throw refuse("writeBody requires expectedBody — a write from a kind without that guard is a clobber");
      }
      const out = await vaultWriteBody(path, body, expectedBody);
      touched();
      return out;
    },
    create: async (
      title: string,
      folder?: string,
      type?: string,
      props?: [string, string][],
      body?: string,
    ) => {
      const out = await vaultCreate(title, folder, type, props, body);
      touched();
      return out;
    },

    onChange: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    openNote: (path: string) => live.current.onOpenSource(path),
    toast: (msg: string, action?: { label: string; run: () => void }) =>
      live.current.onToast?.(msg, action),
    setState,
    /* Not part of the contract — a kind that logs should say who it is. */
    kindId: id,
  };
}
