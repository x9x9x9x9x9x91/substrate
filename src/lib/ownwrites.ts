/* SUB-516 — which paths in a `vault:changed` event are our own echo, and
   which are somebody else's write (docs/undo.md §3.3).

   The engine never emits from its commands: the OS watcher observes the write
   and, ~300ms after the vault goes quiet, emits one event for the whole burst.
   So every app write comes back to us looking exactly like an external one,
   and the app has to recognise its own reflection.

   SUB-116 recognised it by time alone — one global "we wrote at T" stamp, and
   any event within a second of it was ours. That is wrong the moment two
   writes overlap: while a save to A sits inside the window, a real external
   edit to B arrives on the same event and is read as our echo. The undo stack
   keeps entries that now clobber, and the pane never re-reads.

   Here attribution is per path. A path is ours if WE wrote that path inside
   the window; anything else on the event is external, however busy we were
   elsewhere. Commands whose reach we can't name (a folder rename, a rescan)
   record an unnamed write instead, and while one of those is in the window an
   event is read as ours the way it always was — no better than SUB-116 there,
   and deliberately no worse: over-reading those as external would mark the
   folder op's own undo entry stale the instant its echo arrived. */

/** How long after our own write its echo can still arrive. Matches the
    watcher's debounce plus slack (SUB-116's window, unchanged). */
export const ECHO_WINDOW_MS = 1000;

/** path → when we last wrote it. Entries older than the window are dropped on
    every write, so this stays the size of a burst, not of the vault. */
const lastOwn = new Map<string, number>();
/** when we last ran a write whose paths we could not enumerate */
let lastUnnamed = 0;

/** Record a write this app just made. `paths` null = "we wrote, but can't say
    where" — a folder rename, a trash restore of a folder, a rescan. */
export function noteOwnWrite(paths: string[] | null, now: number = Date.now()): void {
  if (paths === null) {
    lastUnnamed = now;
    return;
  }
  for (const [path, at] of lastOwn) {
    if (now - at >= ECHO_WINDOW_MS) lastOwn.delete(path);
  }
  for (const path of paths) lastOwn.set(path, now);
}

export type EchoSplit = {
  /** paths on the event that some other writer changed */
  external: string[];
  /** paths on the event that are our own write coming back */
  own: string[];
  /** the event named nothing we can reason about path-by-path: an empty or
      absent payload (the engine's "unknown, I rescanned" signal, SUB-460), or
      a payload arriving while a write of ours we couldn't enumerate is still
      in the window. Callers stay conservative on this — refresh everything,
      re-read the open note — and fall back to `recentOwn` to decide whether
      it was ours. */
  unknown: boolean;
  /** a write of ours, of any kind, is still inside the echo window. The one
      thing left of SUB-116's global timestamp: when an event names no paths
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
}
