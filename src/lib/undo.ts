/* The session action-undo stack (docs/undo.md §6.1).

   This is layer 2 of the three undo layers: CodeMirror owns text history
   inside the editor, the vault's git history owns the long tail, and this
   owns "the action I just took" — property edits today, more later. It stores
   inverse operations, never snapshots, so undoing never clobbers a
   concurrent change to the rest of the file.

   Pure and node-testable on purpose: App.tsx holds it in a useReducer and
   these functions are the reducer's cases. */

export type UndoScope = "vault" | `pane:${string}`;

export type UndoEntry = {
  id: number;
  /** what the user did, in their words — shown in toasts and menus */
  label: string;
  scope: UndoScope;
  at: number;
  /** every vault path this entry would write when undone or redone */
  paths: string[];
  undo: () => Promise<void>;
  redo?: () => Promise<void>;
  /** why this entry can no longer be run, once it can't be; a stale entry is
      skipped by ⌘Z but stays visible (§3.3 skip-and-show). The two causes are
      the doc's (c) and (d′), and they are NOT interchangeable to a reader:
      "external" is a path this entry touches changed on disk from elsewhere,
      "failed" is this entry's own inverse having thrown. Telling a reader
      their note changed on disk when a write simply errored sends them
      hunting a sync conflict that never happened, so the reason is carried
      rather than assumed. Absent = runnable. */
  stale?: StaleReason;
};

/** (c) somebody else wrote a path this entry would rewrite; (d′) this entry's
    own inverse threw, and retrying it would throw the same way. */
export type StaleReason = "external" | "failed";

export type UndoState = {
  entries: UndoEntry[];
  /** index of the next entry ⌘Z would undo; -1 = nothing left to undo */
  cursor: number;
};

export const MAX_UNDO = 50;

export const emptyUndo: UndoState = { entries: [], cursor: -1 };

let nextId = 1;

/** Mint an entry id ahead of the push. A surface that shows its own "Undo"
    button needs the id at call time so the button and ⌘Z run the same entry
    rather than two lookalike closures that could drift apart. */
export function nextUndoId(): number {
  return nextId++;
}

/** Push a new action. Anything ahead of the cursor (the redo side) is dropped
    — the standard editor rule: acting after undoing forks the history and the
    forked branch is gone. Oldest entries fall off the end past MAX_UNDO. */
export function push(s: UndoState, e: Omit<UndoEntry, "id"> & { id?: number }): UndoState {
  const kept = s.entries.slice(0, s.cursor + 1);
  kept.push({ ...e, id: e.id ?? nextUndoId() });
  const entries = kept.length > MAX_UNDO ? kept.slice(kept.length - MAX_UNDO) : kept;
  return { entries, cursor: entries.length - 1 };
}

/** The entry ⌘Z would run, skipping stale ones (they stay in the list so the
    UI can explain why nothing happened). */
export function peekUndo(s: UndoState): UndoEntry | null {
  for (let i = s.cursor; i >= 0; i--) if (!s.entries[i].stale) return s.entries[i];
  return null;
}

/** The entry ⇧⌘Z would run: the nearest live, redoable entry ahead of the
    cursor. */
export function peekRedo(s: UndoState): UndoEntry | null {
  for (let i = s.cursor + 1; i < s.entries.length; i++) {
    const e = s.entries[i];
    if (!e.stale && e.redo) return e;
  }
  return null;
}

/** Mark every entry that touches one of `paths` stale — called when the vault
    changed from a writer that wasn't us, which makes those inverses unsafe. */
export function invalidate(s: UndoState, paths: string[]): UndoState {
  const hit = new Set(paths);
  let changed = false;
  const entries = s.entries.map((e): UndoEntry => {
    if (e.stale || !e.paths.some((p) => hit.has(p))) return e;
    changed = true;
    return { ...e, stale: "external" };
  });
  return changed ? { ...s, entries } : s;
}

/** Mark one entry stale by id — used when its own inverse failed for a reason
    that isn't a conflict (the file is gone, the write errored). Retrying it
    would fail identically, and leaving it live jams ⌘Z on a dead entry
    forever, so it goes stale and the keystroke walks past it (§3.3). */
export function markStale(s: UndoState, id: number): UndoState {
  const at = s.entries.findIndex((e) => e.id === id);
  if (at === -1 || s.entries[at].stale) return s;
  const entries = s.entries.slice();
  entries[at] = { ...entries[at], stale: "failed" };
  return { ...s, entries };
}

/** Drop every entry belonging to a scope — a pane closing takes its own
    undoable actions with it, so ⌘Z never resurrects a surface that's gone. */
export function evictScope(s: UndoState, scope: UndoScope): UndoState {
  const entries = s.entries.filter((e) => e.scope !== scope);
  if (entries.length === s.entries.length) return s;
  // the cursor follows the entries that survived at or before it
  const cursor = s.entries.slice(0, s.cursor + 1).filter((e) => e.scope !== scope).length - 1;
  return { entries, cursor };
}

/** Move the cursor after an entry's inverse actually ran. Keyed by id, not by
    position: an await elapsed between peek and advance, and if the stack moved
    under us in that window this is a no-op rather than a wrong move. */
export function advance(s: UndoState, id: number, dir: -1 | 1): UndoState {
  // dir -1 undid the entry peekUndo would have returned; dir 1 redid
  // peekRedo's. If the id doesn't match, the stack moved and we leave it be.
  const target = dir === -1 ? peekUndo(s) : peekRedo(s);
  if (!target || target.id !== id) return s;
  const at = s.entries.indexOf(target);
  return { ...s, cursor: dir === -1 ? at - 1 : at };
}

/** The nearest stale entry ⌘Z would have run had it not gone stale — the
    reason nothing happened, so the UI can say so instead of no-oping in
    silence (§3.3 skip-and-show). */
export function peekStale(s: UndoState): UndoEntry | null {
  for (let i = s.cursor; i >= 0; i--) if (s.entries[i].stale) return s.entries[i];
  return null;
}

/** The stale entry ⌘Z walks PAST to reach the one it can still run, or null
    when it walks past nothing.
 *
 *  `peekStale` answers the jammed case — nothing left to run, and a stale
 *  entry as the reason. This answers the quieter one: an external edit
 *  invalidated the newest action, so the keystroke lands on an OLDER action
 *  than the one the user just took. Undoing something is not what "nothing
 *  happened" looks like, so a skip that acts has to say so too (§3.3
 *  skip-and-show) — otherwise ⌘Z reads as having undone the wrong thing.
 *
 *  Only the entry at the cursor is asked: anything below it is only reachable
 *  because that one was skipped, so if the cursor is live nothing was. */
export function skippedStale(s: UndoState): UndoEntry | null {
  const top = s.cursor >= 0 ? s.entries[s.cursor] : undefined;
  return top?.stale ? top : null;
}

/** Why an entry can't run, in the reader's words — the clause both undo
    notices hang off, so neither can invent a cause the stack didn't record.
    A failed inverse used to be reported as a disk conflict, which sent the
    reader looking for a sync problem that never happened; the error itself
    was already toasted at the moment it threw, so this only has to say that
    the earlier attempt is why the entry is being passed over. */
export function staleBecause(entry: UndoEntry): string {
  return entry.stale === "failed" ? "undoing it failed earlier" : "it changed on disk";
}

/** Find an entry by id — the toast action and ⌘Z must run the same operation,
    so the toast holds an id rather than its own closure. */
export function byId(s: UndoState, id: number): UndoEntry | null {
  return s.entries.find((e) => e.id === id) ?? null;
}

/** Test seam: ids are module-global and monotonic, which is right in the app
    and awkward across test cases that assert on them. */
export function __resetUndoIds(): void {
  nextId = 1;
}
