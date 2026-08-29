/* Which paths in a `vault:changed` event are our own echo, and
   which are somebody else's write (docs/undo.md §3.3).

   The engine never emits from its commands: the OS watcher observes the write
   and, ~300ms after the vault goes quiet, emits one event for the whole burst.
   So every app write comes back to us looking exactly like an external one,
   and the app has to recognise its own reflection.

   The first cut recognised it by time alone — one global "we wrote at T" stamp, and
   any event within a second of it was ours. That is wrong the moment two
   writes overlap: while a save to A sits inside the window, a real external
   edit to B arrives on the same event and is read as our echo. The undo stack
   keeps entries that now clobber, and the pane never re-reads.

   Here attribution is per path. A path is ours if WE wrote that path inside
   the window; anything else on the event is external, however busy we were
   elsewhere. Commands whose reach we can't name (a folder rename, a rescan)
   record an unnamed write instead, and while one of those is in the window an
   event is read as ours the way it always was — no better than the first cut there,
   and deliberately no worse: over-reading those as external would mark the
   folder op's own undo entry stale the instant its echo arrived. */

/** How long after our own write its echo can still arrive. Matches the
    watcher's debounce plus slack (the window, unchanged). */
export const ECHO_WINDOW_MS = 1000;

/** path → when we last wrote it. Entries older than the window are dropped on
    every write, so this stays the size of a burst, not of the vault. */
const lastOwn = new Map<string, number>();
/** when we last ran a write whose paths we could not enumerate */
let lastUnnamed = 0;

/* The same knowledge, kept for the note list rather than for undo: which
   paths this app has written since the list last caught up. The list is
   refilled after every mutation, and refilling it meant re-fetching every
   note in the vault to learn about the one that changed. Draining this
   instead names exactly what to re-fetch. It is a ledger, not a window:
   entries wait here until somebody catches up on them, however long that
   takes, because a path dropped on a timer would be a row left stale. */
const unsynced = new Set<string>();
/** a write with unnameable reach is pending — the list must be re-fetched
    whole, the same conservative answer `unknown` gives on the event side */
let unsyncedUnnamed = false;

/** Everything written since the last drain. `unnamed` is the write whose
    reach nobody could name, and the caller re-lists on it; an empty `paths`
    with `unnamed` false is simply a refresh with no write behind it (mount,
    a rescan, the user asking), which re-lists too. */
export function takeUnsyncedWrites(): { paths: string[]; unnamed: boolean } {
  const out = { paths: [...unsynced], unnamed: unsyncedUnnamed };
  unsynced.clear();
  unsyncedUnnamed = false;
  return out;
}

/** Put a drained batch back. Draining means "the list is about to catch up on
    these", and a refresh that fetched nothing — its patch rejected AND the
    whole-list fallback behind it rejected — never did. Without this the paths
    are gone and their rows stay stale until something unrelated re-lists. */
export function requeueUnsyncedWrites(paths: string[], unnamed: boolean): void {
  for (const path of paths) unsynced.add(path);
  if (unnamed) unsyncedUnnamed = true;
}

/** File a write in the list's ledger only, without claiming its echo.
    Commands whose writes the OS watcher attributes to us go through
    `noteOwnWrite`; this is for the ones that change the index some other way
    — installing a recipe, mounting or unmounting a folder, a sync checkout.
    The list still has to hear about them, or the next refresh patches a
    ledger that never covered them and the new notes are simply missing. */
export function noteIndexWrite(paths: string[] | null): void {
  if (paths === null) {
    unsyncedUnnamed = true;
    return;
  }
  for (const path of paths) unsynced.add(path);
}

/** Record a write this app just made. `paths` null = "we wrote, but can't say
    where" — a folder rename, a trash restore of a folder, a rescan. */
export function noteOwnWrite(paths: string[] | null, now: number = Date.now()): void {
  if (paths === null) {
    lastUnnamed = now;
    unsyncedUnnamed = true;
    return;
  }
  for (const [path, at] of lastOwn) {
    if (now - at >= ECHO_WINDOW_MS) lastOwn.delete(path);
  }
  for (const path of paths) {
    lastOwn.set(path, now);
    unsynced.add(path);
  }
}

export type EchoSplit = {
  /** paths on the event that some other writer changed */
  external: string[];
  /** paths on the event that are our own write coming back */
  own: string[];
  /** the event named nothing we can reason about path-by-path: an empty or
      absent payload (the engine's "unknown, I rescanned" signal), or
      a payload arriving while a write of ours we couldn't enumerate is still
      in the window. Callers stay conservative on this — refresh everything,
      re-read the open note — and fall back to `recentOwn` to decide whether
      it was ours. */
  unknown: boolean;
  /** a write of ours, of any kind, is still inside the echo window. The one
      thing left of the global timestamp: when an event names no paths
      there is nothing else to go on. */
  recentOwn: boolean;
};

/** Split a `vault:changed` payload into our echo and everyone else's writes. */
export function splitEcho(paths: string[] | null, now: number = Date.now()): EchoSplit {
  const recentOwn =
    now - lastUnnamed < ECHO_WINDOW_MS ||
    [...lastOwn.values()].some((at) => now - at < ECHO_WINDOW_MS);
  if (!paths || paths.length === 0) return { external: [], own: [], unknown: true, recentOwn };
  // an unnamed write of ours is in flight: it could have touched anything on
  // this event, so nothing here can be called external without risking
  // marking that very operation's own undo entry stale
  if (now - lastUnnamed < ECHO_WINDOW_MS) {
    return { external: [], own: [...paths], unknown: true, recentOwn };
  }
  const own: string[] = [];
  const external: string[] = [];
  for (const path of paths) {
    const at = lastOwn.get(path);
    if (at !== undefined && now - at < ECHO_WINDOW_MS) own.push(path);
    else external.push(path);
  }
  return { external, own, unknown: false, recentOwn };
}

/** Test seam — the registry is module-global, which is right in the app and
    leaks between test cases. */
export function __resetOwnWrites(): void {
  lastOwn.clear();
  lastUnnamed = 0;
  unsynced.clear();
  unsyncedUnnamed = false;
}
