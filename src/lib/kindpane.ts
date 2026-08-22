/* Custom dashboard kinds — the decisions the pane makes.

   `kinds.ts` owns the format and the per-bundle state machine; this module
   owns what `DashboardBody` does with them: which of the four panes a
   `dashboard:` value resolves to, and which card a bundle that can't run
   shows. Both are pure so `node --test` can hold the whole dispatch table
   (the repo has no React component runner — the rendering half is e2e).

   The one invariant worth stating twice: a `dashboard:` value that names a
   bundle NEVER reaches the body-scan fallback. That fallback belongs
   to notes naming no kind at all; using it for a kind the user disabled
   would answer "show me gear-log" with whatever the body happens to hold. */

import {
  BUILT_IN_KINDS,
  KIND_API,
  KIND_API_MIN,
  resolveDashboardKind,
  resolveKindState,
  type KindBundleInfo,
  type KindEnableRecord,
  type KindFileMeta,
  type KindManifest,
  type KindState,
} from "./kinds.ts";

/** What `DashboardBody` should render for one note.

    `custom` carries the resolved `KindState`, not just "there is a bundle":
    the pane mounts on `enabled` and shows a card for everything else, and
    keeping the state here means the disabled-never-falls-back guard is one
    branch rather than a rule spread over the component. */
export type KindPaneDispatch =
  | { pane: "body-scan" }
  | { pane: "built-in"; kind: string }
  | {
      pane: "custom";
      id: string;
      hash: string;
      state: KindState;
      /** the consent record, when there is one — the review pane needs the
          standing "trust updates" rider, which the state alone doesn't carry */
      record?: KindEnableRecord;
      /** what the hash covers, for the review pane's file list */
      files?: KindFileMeta[];
    }
  | { pane: "unknown"; kind: string; message: string };

/** Resolve one note's `dashboard:` prop against the installed bundles.

    Order: built-ins win outright (a colliding bundle is invalid anyway, and
    resolving it here would be a second place that decision could drift);
    then a bundle claiming the name, in whatever state it is in; only a name
    that is neither gets the unknown-kind card. */
export function resolveKindPane(
  kind: string | undefined,
  bundles: readonly KindBundleInfo[],
): KindPaneDispatch {
  const resolved = resolveDashboardKind(kind);
  if (resolved.dispatch === "body-scan") return { pane: "body-scan" };
  if (resolved.dispatch === "built-in") return { pane: "built-in", kind: resolved.kind };

  const name = resolved.kind;
  const bundle = bundles.find((b) => b.id === name);
  if (!bundle) return { pane: "unknown", kind: name, message: resolved.message };
  return {
    pane: "custom",
    id: bundle.id,
    hash: bundle.hash,
    state: resolveKindState(bundle, bundle.record),
    ...(bundle.record ? { record: bundle.record } : {}),
    ...(bundle.files ? { files: bundle.files } : {}),
  };
}

/** True when `id` is a name the app renders itself — the collision check the
    enable surface and the dispatch above agree on. */
export function isBuiltInKind(id: string): boolean {
  return BUILT_IN_KINDS.has(id);
}

// ---------- error cards ----------

/** Which card a non-running kind shows. `review-pending` covers both "never
    enabled" and "the bytes changed since you enabled it": the sentences
    differ, the card and the action behind it do not. `runtime-error` is the
    only one the pure layer can't derive — it comes from a failed import or a
    throwing `mount`, so the component hands it in. */
export type KindCardKind =
  | "review-pending"
  | "api-too-new"
  | "api-too-old"
  | "invalid-bundle"
  | "runtime-error";

/** A card, ready to render: the head's state label plus the body sentence.
    Every message names the kind, and names the offending file whenever there
    is one — "gear-log is broken" without a filename is a bug report nobody
    can act on. */
export interface KindCard {
  card: KindCardKind;
  /** the DashHead state label — short, lowercase, no colour */
  label: string;
  message: string;
}

/** The card for a resolved-but-not-running bundle, or null when it runs.
    `review-pending` is the headline only: the pane draws the review itself
    from `kindReview`, which carries what a person needs in order to decide. */
export function kindStateCard(id: string, state: KindState): KindCard | null {
  switch (state.state) {
    case "enabled":
      return null;
    case "disabled":
      return {
        card: "review-pending",
        label: "review pending",
        message: reviewPending(id, state.manifest, false),
      };
    case "hash-drift":
      return {
        card: "review-pending",
        label: "code changed",
        message: reviewPending(id, state.manifest, true),
      };
    case "api-too-new":
      return {
        card: "api-too-new",
        label: "needs a newer Substrate",
        message: `“${id}” (${state.manifest.entry}) is written for kind api ${state.manifest.api}; this build speaks api ${apiWindow()}. Update Substrate to run it.`,
      };
    case "api-too-old":
      return {
        card: "api-too-old",
        label: "kind too old",
        message: `“${id}” (${state.manifest.entry}) is written for kind api ${state.manifest.api}, a contract this build has dropped — it speaks api ${apiWindow()}. Its author needs to update it.`,
      };
    case "invalid":
      return {
        card: "invalid-bundle",
        label: "invalid kind",
        message: `“${id}” cannot be loaded — ${state.reason}`,
      };
  }
}

/** What the app ignored in a manifest it otherwise accepted, or null when it
    ignored nothing.

    A key this build does not read is not a reason to refuse the bundle — a
    kind written against a later build may carry keys this one has no use for.
    But the common case is a typo, and a typo'd `style` mounts the kind with
    no stylesheet and nothing said: the kind renders, wrongly, and the author
    has only the look of it to go on. So the keys are named where the kind
    itself renders. */
export function kindManifestNotice(id: string, manifest: KindManifest): string | null {
  const keys = manifest.unknownKeys;
  if (!keys || keys.length === 0) return null;
  const list = keys.map((k) => `“${k}”`).join(", ");
  return `${keys.length === 1 ? "A key" : "Keys"} in “${id}”’s kind.json ${
    keys.length === 1 ? "is" : "are"
  } not read by this build: ${list}. A misspelled key is ignored in full — the kind still runs, without whatever it was meant to set.`;
}

/** A vault bundle whose folder is named after a dashboard kind the app renders
    itself, or null when there is no collision.

    The built-in wins the dispatch, and it wins it before the bundle list is
    even consulted — so the note showed the built-in's own empty state ("No
    cards yet — add a cards: list…") about a note whose author had just written
    a whole bundle. Nothing on the pane said the bundle existed, had parsed, or
    had lost. The settings sheet says it; the pane an author is looking at
    while debugging did not. */
export function builtInShadowNotice(kind: string, bundles: readonly KindBundleInfo[]): string | null {
  const hit = bundles.find((b) => b.id.toLowerCase() === kind.toLowerCase());
  if (!hit) return null;
  return `“${kind}” is a dashboard kind this app renders itself, so the bundle in the vault’s kinds folder is not being used. Rename that folder to something the app doesn’t already claim.`;
}

/** The card for a kind that resolved fine and then failed to run. `file` is
    the entry (or the stylesheet) the failure came from, so the message points
    at a file the user can open. */
export function kindRuntimeCard(id: string, file: string, error: string): KindCard {
  return {
    card: "runtime-error",
    label: "kind failed",
    message: `“${id}” failed while running ${file}: ${error}`,
  };
}

/* The api window as a human reads it — one number while the floor and the
   ceiling agree, a range once the window widens. Derived from the constants
   so the sentence can't claim a version this build doesn't speak. */
function apiWindow(): string {
  return KIND_API_MIN === KIND_API ? String(KIND_API) : `${KIND_API_MIN}–${KIND_API}`;
}

function reviewPending(id: string, manifest: KindManifest, drifted: boolean): string {
  return drifted
    ? `The code in “${id}” changed since you enabled it, so ${manifest.entry} stopped running. Look at what changed before enabling it again.`
    : `“${id}” has not been enabled on this device. ${manifest.entry} runs only after you review it.`;
}

// ---------- the review ----------

/** Everything the review pane shows about a bundle awaiting consent.
    Assembled here rather than in the component so the sentences a person
    decides on are covered by `node --test` — the component owns the buttons,
    this owns what they are agreeing to. */
export interface KindReview {
  id: string;
  /** `first` — never enabled here. `changed` — enabled once, bytes drifted. */
  moment: "first" | "changed";
  title: string;
  /** the manifest's own words, empty when it had none */
  description: string;
  author?: string;
  api: number;
  entry: string;
  /** the files the hash covers, in the order they were hashed */
  files: readonly KindFileMeta[];
  /** "3 files · 4.1 kB", or "" when the build handed over no file metadata */
  fileSummary: string;
  /** the state's headline sentence — same one `kindStateCard` shows */
  headline: string;
  /** what enabling means, in plain words. Rendered as separate lines. */
  terms: readonly string[];
  /** the enable button's words */
  enableLabel: string;
  /** the standing-permission checkbox, and whether it is currently on */
  trustLabel: string;
  trustHint: string;
  trustUpdates: boolean;
}

/** The plain-words terms. Deliberately three short sentences and no link to
    a longer policy: the whole grant is "this code runs as the app does, here,
    until you disable it", and a person who has to click through to find that
    out has already been asked to trust something they can't see. */
const TERMS: readonly string[] = [
  "Custom kinds run with the same access as Substrate itself — your whole vault, read and write.",
  "Enabling applies to this vault on this device only. Other devices ask again, even after a sync.",
  "Consent is pinned to these exact files. If the code changes, it stops running until you look again.",
];

/** The review for a bundle awaiting consent, or null when there is nothing to
    decide.

    Null covers both ends: an enabled kind (already decided) and a kind this
    build cannot run at all — a too-new api, a too-old one, a broken manifest.
    Those show their card and no enable affordance, because consent to code
    that cannot execute buys nothing and trains the click. */
export function kindReview(
  id: string,
  state: KindState,
  files: readonly KindFileMeta[] | undefined,
  record: KindEnableRecord | undefined,
): KindReview | null {
  if (state.state !== "disabled" && state.state !== "hash-drift") return null;
  const m = state.manifest;
  const drifted = state.state === "hash-drift";
  const list = files ?? [];
  return {
    id,
    moment: drifted ? "changed" : "first",
    title: m.title,
    description: m.description,
    ...(m.author ? { author: m.author } : {}),
    api: m.api,
    entry: m.entry,
    files: list,
    fileSummary: fileSummary(list),
    headline: reviewPending(id, m, drifted),
    terms: TERMS,
    enableLabel: drifted ? "Enable the new code" : "Enable for this vault",
    trustLabel: "Trust updates to this kind in this vault",
    trustHint:
      "Re-enables it automatically when its files change here. For a kind you are editing yourself — leave it off for one you were given.",
    trustUpdates: record?.trustUpdates === true,
  };
}

/** True when the state offers an enable button at all. The same predicate the
    settings list and the pane use, so "no affordance" can't mean two things. */
export function canEnableKind(state: KindState): boolean {
  return state.state === "disabled" || state.state === "hash-drift";
}

/** Whether a drift should clear itself without asking.
    Only ever true for a kind that was enabled, whose record carries the
    standing permission, and whose bytes are the thing that moved. Every other
    path — including a first enable — goes through the card. */
export function shouldTrustReenable(state: KindState, record: KindEnableRecord | undefined): boolean {
  return state.state === "hash-drift" && record?.trustUpdates === true;
}

/** "3 files · 4.1 kB". Empty when the build handed over no file metadata, so
    the pane can drop the line rather than claim "0 files" about a bundle it
    just hashed. */
export function fileSummary(files: readonly KindFileMeta[]): string {
  if (files.length === 0) return "";
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return `${files.length} file${files.length === 1 ? "" : "s"} · ${formatBytes(bytes)}`;
}

/** Sizes as a person reads them: whole bytes up to a kB, one decimal above.
    Decimal kB/MB rather than KiB — the number next to a filename should match
    what the OS file manager says about the same file. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / (1000 * 1000)).toFixed(1)} MB`;
}

// ---------- bundle URLs ----------

/** The `substrate-kind:` origin for this platform. Tauri serves a custom
    scheme as `substrate-kind://localhost/…` on macOS/iOS/Linux and as
    `http://substrate-kind.localhost/…` on Windows/Android; both spellings
    are in the shipped CSP (`docs/security-config.md`). Taking the user agent
    as an argument keeps the choice testable. */
export function kindSchemeOrigin(userAgent: string): string {
  return /windows|android/i.test(userAgent)
    ? "http://substrate-kind.localhost"
    : "substrate-kind://localhost";
}

/** One bundle file's URL, cache-busted by its bundle hash.

    The `?v=` is not about HTTP caching (the scheme handler already answers
    `Cache-Control: no-store`) — it is about the webview's module registry,
    which is keyed by URL for the lifetime of the page. Without it, an agent
    rewriting a kind and the user re-enabling it would keep running the
    module imported at boot until the app relaunched. */
export function kindFileUrl(origin: string, id: string, file: string, hash: string): string {
  return `${origin}/${encodeURIComponent(id)}/${encodeURIComponent(file)}?v=${hashTag(hash)}`;
}

/** The short form of a bundle hash used in URLs — 12 hex characters, enough
    to separate two versions of one bundle, short enough to read in devtools. */
export function hashTag(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 12);
}
