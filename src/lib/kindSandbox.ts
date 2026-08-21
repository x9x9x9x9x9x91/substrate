/* The containment surface the kind host wraps around vault-resident code.

   Two separate problems, one module, because both are the same shape: the
   host is on the stack while the kind's `mount` runs, so for exactly that
   window it can attribute what the kind does to the kind — and clean up
   after it later.

   1. WINDOW-LEVEL REGISTRATIONS. A kind that arms `setInterval` and returns
      no cleanup used to leave that timer ticking for the life of the app,
      accumulating one per pane visit, while its `ctx.onChange` subscription
      was reclaimed properly. The asymmetry is the trap: an author who tests
      the documented cleanup path and generalises ships a leak nothing in the
      UI ever mentions. `armKindSandbox` patches the window's timer and
      listener entry points for as long as a kind is mounted and records
      only what is armed while the kind's own code is running, so unmount can
      cancel exactly those.

   2. DOM ESCAPES. The kind is handed one element and owns what is inside it;
      everything outside is the host's. A kind that appends to `document.body`
      instead — or empties a container that is not its own — leaves the pane
      blank with the damage still on screen and nothing anywhere saying so.
      `watchKindDom` records the mutations a `mount` call makes outside that
      element, puts the DOM back, and hands the host a sentence naming what
      it caught.

   WHAT THIS IS NOT. It is not a security boundary and cannot be one: vault
   code runs with the app's own access by design (vault-format §5.8, and the
   consent flow exists because of it). A kind that wants to reach around this
   can, trivially — it holds the same globals the host does. What it buys is
   containment of the ACCIDENT: the leak nobody meant to ship, the stray write
   that blanks the pane, both caught at the boundary where they are still
   attributable.

   RESIDUALS, stated rather than implied — both follow from attribution, not
   from effort:
   - Only the SYNCHRONOUS body of the kind's code is attributable. Anything a
     kind arms from a promise continuation the host never awaited runs with no
     host frame on the stack and no way to tell it apart from the app's own
     work, so it is neither recorded nor repaired. Timers armed inside a
     recorded timer's callback ARE covered — the wrapper re-enters attribution
     for the callback — which is what makes the common `setInterval` and
     chained-`setTimeout` shapes contained in practice.
   - The DOM watcher repairs structure: nodes added outside the kind's element
     are removed, nodes removed from outside it are put back. It does not
     restore attributes, text content or inline styles a kind overwrote in
     place, and it does not unwind writes to anything that is not the DOM.
   - `hostSurface` re-attributes the host code a kind calls THROUGH IT — the
     `ctx` members, and only for the synchronous body of that call. Host code
     the kind re-enters by another route is still the kind's as far as the
     ledger is concerned: a kind that dispatches a window event which an app
     listener answers by arming a `setTimeout` puts that timer on the kind's
     ledger, and unmounting the pane cancels it. The same goes for host work
     the ctx member defers into a continuation. This is the accepted cost of
     stack-window attribution, not an oversight; the shapes it bites are
     rare, and the failure is an app timer cancelled early rather than a kind
     leak left running. */

/** What the host holds while one kind is mounted. */
export interface KindSandbox {
  /** Run the kind's own code. Timers, frames and window/document listeners
      armed inside — and inside the callbacks of anything armed inside —
      belong to this kind and are cancelled by `release`. */
  run<T>(fn: () => T): T;
  /** Run host code the kind called into (a `ctx` member). What the app arms
      while serving a kind's request is the app's, not the kind's: a toast's
      dismiss timer must outlive the pane that raised it. */
  host<T>(fn: () => T): T;
  /** Cancel everything recorded, then drop this sandbox's patches. Safe to
      call twice — unmount and a mid-life failure both go through it. */
  release(): void;
  /** What is still armed, for tests and for the evidence a leak was real. */
  outstanding(): { timers: number; frames: number; listeners: number };
}

interface ListenerRecord {
  target: EventTarget;
  type: string;
  /** what we passed to addEventListener, which is what must be removed */
  wrapped: EventListener;
  /** what the kind passed, so its own removeEventListener still works */
  original: EventListenerOrEventListenerObject;
  capture: boolean;
}

/* The patches are installed once for as many sandboxes as are live at a time
   (a workbook page swap can briefly overlap two), and `active` says which one
   — if any — is currently being attributed to. Nothing is recorded while it
   is null, so the app's own timers keep behaving exactly as they did. */
let installed = 0;

/* Every ledger that has not been released yet. `active` is the one being
   attributed to right now; `live` is who can still be asked about a listener
   — a kind that removes one from a promise continuation has no active
   sandbox, and a workbook page swap can leave two overlapping. */
let active: Ledger | null = null;
const live = new Set<Ledger>();
let originals: {
  setInterval: typeof window.setInterval;
  setTimeout: typeof window.setTimeout;
  requestAnimationFrame: typeof window.requestAnimationFrame;
  winAdd: typeof window.addEventListener;
  docAdd: typeof document.addEventListener;
  winRemove: typeof window.removeEventListener;
  docRemove: typeof document.removeEventListener;
} | null = null;

type TimerFn = (...args: unknown[]) => void;

/** One mounted kind's ledger — what the patches write to while it is the
    attributed sandbox. A closure rather than a class: the patches hold it
    directly, and there is no `this` to lose across a callback boundary. */
interface Ledger extends KindSandbox {
  addInterval(id: number): void;
  addTimeout(id: number): void;
  dropTimeout(id: number): void;
  addFrame(id: number): void;
  dropFrame(id: number): void;
  addListener(rec: ListenerRecord): void;
  dropListener(
    target: EventTarget,
    type: string,
    original: unknown,
    capture: boolean,
  ): ListenerRecord | undefined;
}

function createLedger(): Ledger {
  const intervals = new Set<number>();
  const timeouts = new Set<number>();
  const frames = new Set<number>();
  let listeners: ListenerRecord[] = [];
  let released = false;

  const self: Ledger = {
    run(fn) {
      if (released) return fn();
      const prev = active;
      active = self;
      try {
        return fn();
      } finally {
        active = prev;
      }
    },
    host(fn) {
      const prev = active;
      active = null;
      try {
        return fn();
      } finally {
        active = prev;
      }
    },
    release() {
      if (released) return;
      released = true;
      live.delete(self);
      for (const id of intervals) window.clearInterval(id);
      for (const id of timeouts) window.clearTimeout(id);
      for (const id of frames) window.cancelAnimationFrame(id);
      for (const l of listeners) l.target.removeEventListener(l.type, l.wrapped, l.capture);
      intervals.clear();
      timeouts.clear();
      frames.clear();
      listeners = [];
      if (active === self) active = null;
      uninstall();
    },
    outstanding() {
      return {
        timers: intervals.size + timeouts.size,
        frames: frames.size,
        listeners: listeners.length,
      };
    },

    /* --- what the patches call --- */

    addInterval: (id) => void intervals.add(id),
    addTimeout: (id) => void timeouts.add(id),
    dropTimeout: (id) => void timeouts.delete(id),
    addFrame: (id) => void frames.add(id),
    dropFrame: (id) => void frames.delete(id),
    addListener: (rec) => void listeners.push(rec),
    dropListener(target, type, original, capture) {
      const i = listeners.findIndex(
        (l) =>
          l.target === target && l.type === type && l.original === original && l.capture === capture,
      );
      if (i < 0) return undefined;
      const [rec] = listeners.splice(i, 1);
      return rec;
    },
  };
  live.add(self);
  return self;
}

/** Arm the window patches and hand back the sandbox one mounted kind owns. */
export function armKindSandbox(): KindSandbox {
  install();
  return createLedger();
}

function captureFlag(options: boolean | AddEventListenerOptions | undefined): boolean {
  return typeof options === "boolean" ? options : (options?.capture ?? false);
}

function install() {
  installed += 1;
  if (originals) return;
  originals = {
    setInterval: window.setInterval,
    setTimeout: window.setTimeout,
    requestAnimationFrame: window.requestAnimationFrame,
    winAdd: window.addEventListener,
    docAdd: document.addEventListener,
    winRemove: window.removeEventListener,
    docRemove: document.removeEventListener,
  };
  const o = originals;

  /* Every patch has the same three beats: no active sandbox (or a handler
     shape we can't wrap, like setTimeout's legacy string form) means the
     original, untouched; otherwise arm the original with the callback wrapped
     so the kind's own code stays attributable when it runs, and record the
     handle so `release` can cancel it. */
  window.setInterval = function patchedSetInterval(handler: unknown, timeout?: number, ...args: unknown[]) {
    const sb = active;
    if (!sb || typeof handler !== "function") {
      return (o.setInterval as (...a: unknown[]) => number).call(window, handler, timeout, ...args);
    }
    const fn = handler as TimerFn;
    const id = o.setInterval.call(window, (...a: unknown[]) => sb.run(() => fn(...a)), timeout, ...args);
    sb.addInterval(id as unknown as number);
    return id;
  } as typeof window.setInterval;

  window.setTimeout = function patchedSetTimeout(handler: unknown, timeout?: number, ...args: unknown[]) {
    const sb = active;
    if (!sb || typeof handler !== "function") {
      return (o.setTimeout as (...a: unknown[]) => number).call(window, handler, timeout, ...args);
    }
    const fn = handler as TimerFn;
    let id = 0;
    id = o.setTimeout.call(
      window,
      (...a: unknown[]) => {
        // A one-shot that has fired is not outstanding: forgetting it here
        // keeps `outstanding()` honest and keeps the set from growing for the
        // life of a long-running kind that polls with chained timeouts.
        sb.dropTimeout(id);
        sb.run(() => fn(...a));
      },
      timeout,
      ...args,
    ) as unknown as number;
    sb.addTimeout(id);
    return id;
  } as typeof window.setTimeout;

  window.requestAnimationFrame = function patchedRaf(cb: FrameRequestCallback) {
    const sb = active;
    if (!sb || typeof cb !== "function") return o.requestAnimationFrame.call(window, cb);
    let id = 0;
    id = o.requestAnimationFrame.call(window, (t) => {
      sb.dropFrame(id);
      sb.run(() => cb(t));
    });
    sb.addFrame(id);
    return id;
  };

  const patchAdd = (target: EventTarget, orig: typeof window.addEventListener) =>
    function patchedAdd(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      const sb = active;
      if (!sb || typeof listener !== "function") {
        return orig.call(target, type, listener as EventListener, options);
      }
      const capture = captureFlag(options);
      const wrapped: EventListener = (ev) => sb.run(() => listener.call(target, ev));
      sb.addListener({ target, type, wrapped, original: listener, capture });
      return orig.call(target, type, wrapped, options);
    } as typeof window.addEventListener;

  window.addEventListener = patchAdd(window, o.winAdd);
  document.addEventListener = patchAdd(document, o.docAdd);

  /* Removal needs a patch of its own, because a kind removing its own
     listener hands us the function IT passed — not the wrapper that was
     actually registered — so the pairing has to be looked up. Patched per
     target rather than on `EventTarget.prototype`, which would reach every
     other target in the app for no gain.

     The lookup asks every live ledger, not just the attributed one. Removal
     is the half of the pair that routinely happens with no host frame on the
     stack — `fetch(...).then(() => window.removeEventListener(...))`, a
     timer the app armed, a kind cleaning up on an event — and consulting
     only `active` there finds nothing, unregisters the raw function instead
     of the wrapper, and leaves a listener the kind believes it removed still
     firing until unmount. Identity is (target, type, listener, capture), so
     two overlapping sandboxes cannot claim each other's pairs. */
  const patchRemove = (target: EventTarget, orig: typeof window.removeEventListener) =>
    function patchedRemove(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      const capture = captureFlag(options);
      let rec = active?.dropListener(target, type, listener, capture);
      if (!rec) {
        for (const led of live) {
          rec = led.dropListener(target, type, listener, capture);
          if (rec) break;
        }
      }
      return orig.call(target, type, rec ? rec.wrapped : (listener as EventListener), options);
    } as typeof window.removeEventListener;

  window.removeEventListener = patchRemove(window, o.winRemove);
  document.removeEventListener = patchRemove(document, o.docRemove);
}

function uninstall() {
  installed = Math.max(0, installed - 1);
  if (installed > 0 || !originals) return;
  window.setInterval = originals.setInterval;
  window.setTimeout = originals.setTimeout;
  window.requestAnimationFrame = originals.requestAnimationFrame;
  window.addEventListener = originals.winAdd;
  document.addEventListener = originals.docAdd;
  window.removeEventListener = originals.winRemove;
  document.removeEventListener = originals.docRemove;
  originals = null;
}

/** The `ctx` a kind is handed, wrapped so calls INTO the host are attributed
    to the host.

    Without this, `ctx.toast("saved")` — host code, reached through a kind —
    arms its dismiss timer while the kind is the attributed sandbox, and
    unmounting the pane cancels a toast the app owns. Same for anything the
    host schedules on the way through: a React state update's scheduler
    fallback, a debounce inside the app.

    A Proxy rather than a rebuilt object because `ctx.note` is a getter and
    has to stay one: the kind reads it for a fresh snapshot each time.

    What it does NOT claim: that all host work reached from a kind is billed
    to the host. It covers the synchronous body of a call made through this
    surface. Host code the kind re-enters some other way — dispatching an
    event the app listens for is the reachable one — runs with the kind
    attributed, and anything the app arms there is cancelled at unmount. See
    the module header's fourth residual. */
export function hostSurface<T extends object>(ctx: T, sandbox: KindSandbox): T {
  return new Proxy(ctx, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        sandbox.host(() => (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
}

// ---------- DOM escapes ----------

/** What one `mount` call did outside the element it was given, after the
    host put the DOM back. */
export interface KindEscape {
  /** nodes the kind added outside its element, since removed */
  added: number;
  /** nodes it removed from outside its element, since re-inserted */
  removed: number;
  /** the containers involved, as a reader would name them */
  where: string[];
  /** one sentence for the error card */
  summary: string;
}

/** Watch the document while the kind's own code runs, and hand back what it
    did outside `own` — with the damage already undone.

    Attribution is exact for the window it covers: JavaScript is
    single-threaded, so between `start()` and `stop()` around a synchronous
    call nothing but the kind can have touched the DOM. That is also the
    limit — see the module header's residuals. */
export function watchKindDom(own: Element): { stop: () => KindEscape | null } {
  const root = own.ownerDocument?.documentElement;
  if (!root || typeof MutationObserver !== "function") return { stop: () => null };
  const obs = new MutationObserver(() => {
    /* records are drained by hand in stop(); the callback exists because the
       constructor requires one */
  });
  obs.observe(root, { childList: true, subtree: true });

  return {
    stop() {
      const records = obs.takeRecords();
      obs.disconnect();
      let added = 0;
      let removed = 0;
      const where = new Set<string>();

      /* Containment is decided as of the MUTATION, not as of this drain.
         Records are replayed in the order they happened and every node that
         goes into — or comes out of — something the kind already owns is
         marked owned itself, so a container that has since left the tree is
         still recognised as the kind's.

         Judging by `own.contains(target)` here instead accused the ordinary
         redraw: a kind that builds a box inside its element, fills it, then
         re-sets `innerHTML` (or calls `replaceChildren`, or drops a scratch
         node it was done with) leaves the fills pointing at a container that
         is detached by the time we look — outside `own` by that test, and so
         a stray write, and so a dead pane for code that never left home. */
      const owned = new Set<Node>();
      const kindsBusiness = (node: Node): boolean => {
        for (let n: Node | null = node; n; n = n.parentNode) {
          if (n === own || owned.has(n)) return true;
        }
        return false;
      };

      for (const r of records) {
        const target = r.target as Node;
        // inside the kind's own element is the kind's business
        if (kindsBusiness(target)) {
          for (const node of Array.from(r.addedNodes)) owned.add(node);
          for (const node of Array.from(r.removedNodes)) owned.add(node);
          continue;
        }
        for (const node of Array.from(r.addedNodes)) {
          if (node === own || own.contains(node) || node.contains?.(own)) continue;
          (node as ChildNode).remove?.();
          added += 1;
          where.add(describe(target));
        }
        for (const node of Array.from(r.removedNodes)) {
          // `own` itself is repaired like any other host node: a kind that
          // removes the element it was handed has blanked the pane, and
          // putting it back is the difference between a card and nothing.
          if (node !== own && own.contains(node)) continue;
          // Put it back where it was. `nextSibling` is the anchor the record
          // carries; if that node has since moved on, the end of the
          // container is the honest approximation — order inside a container
          // the kind was never meant to touch is worth less than the node
          // being on screen at all.
          const anchor = r.nextSibling && r.nextSibling.parentNode === target ? r.nextSibling : null;
          try {
            target.insertBefore(node, anchor);
            removed += 1;
            where.add(describe(target));
          } catch {
            // A node that refuses to go back (a document fragment's child, a
            // target since detached) is counted anyway: the card's job is to
            // say the kind did this, and half-repaired is still not silent.
            removed += 1;
            where.add(describe(target));
          }
        }
      }
      if (!added && !removed) return null;
      const parts: string[] = [];
      if (added) parts.push(`${added} ${added === 1 ? "element" : "elements"} added`);
      if (removed) parts.push(`${removed} ${removed === 1 ? "element" : "elements"} removed`);
      const list = [...where];
      return {
        added,
        removed,
        where: list,
        summary: `it wrote outside the element it was given (${parts.join(", ")} in ${list.join(", ")}). The app put that back and stopped the kind — draw into the el your mount(el, ctx) was handed.`,
      };
    },
  };
}

/** A container named the way someone reading the card would name it. */
function describe(node: Node): string {
  if (node.nodeType !== 1) return node.nodeName.toLowerCase();
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = !id && el.classList.length ? `.${el.classList[0]}` : "";
  return `<${tag}${id}${cls}>`;
}
