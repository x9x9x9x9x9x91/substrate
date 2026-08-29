import { useCallback, useMemo, useReducer, useRef } from "react";
import * as undoStack from "../lib/undo";
import type { UndoEntry, UndoState } from "../lib/undo";
import type { UndoApi } from "../lib/undoContext";
import type { ToastAction } from "./useToast";
import { errText } from "../lib/errtext";

/* The session undo stack lives here, in one reducer, because ⌘Z is
   global: whichever surface made the edit, the keystroke arrives at the
   document. The pure moves are in lib/undo.ts; this is only their dispatch. */
/** What a ⌘Z press resolves to once its turn comes: the entry to run, plus
    the staled one the keystroke walked past to reach it (§3.3), if any. */
export type UndoRun = { entry: UndoEntry | null; skipped?: UndoEntry };

export type UndoAction =
  /** `id` is optional on the way in and always set by the time the reducer
      sees it — the dispatcher mints one first, because this action is applied
      to two places and a self-minting push would give them different ids. */
  | { t: "push"; entry: Omit<UndoEntry, "id"> & { id?: number } }
  | { t: "invalidateAll" }
  | { t: "invalidate"; paths: string[] }
  | { t: "markStale"; id: number }
  | { t: "evictScope"; scope: UndoEntry["scope"] }
  | { t: "advance"; id: number; dir: -1 | 1 };

function undoReducer(s: UndoState, a: UndoAction): UndoState {
  switch (a.t) {
    case "push":
      return undoStack.push(s, a.entry);
    // the conservative reading, for the events that still name nothing: an
    // empty vault:changed payload is the engine saying it lost track and
    // rescanned, so any inverse might now clobber an edit we can't see
    // (docs/undo.md §3.3)
    case "invalidateAll":
      return undoStack.invalidate(
        s,
        s.entries.flatMap((e) => e.paths)
      );
    // The event named its paths, so only the entries that touch one
    // of them are unsafe — everything else stays runnable
    case "invalidate":
      return undoStack.invalidate(s, a.paths);
    // one entry's inverse failed for its own reason — retrying it would fail
    // the same way, so it goes stale and ⌘Z reaches the edit below it
    case "markStale":
      return undoStack.markStale(s, a.id);
    case "evictScope":
      return undoStack.evictScope(s, a.scope);
    case "advance":
      return undoStack.advance(s, a.id, a.dir);
  }
}

/* Session undo. The stack holds inverse operations; running one
   is async (it's a vault write), so the cursor only moves after the write
   lands, keyed by entry id in case the stack shifted meanwhile. A refused
   inverse means someone else changed the prop: say so and mark it stale
   rather than retry. */
export function useUndoStack(
  refresh: (ownWrite?: boolean, paths?: string[] | null) => void,
  showToast: (msg: string, action?: ToastAction) => void
) {
  const [undoState, reduce] = useReducer(undoReducer, undoStack.emptyUndo);

  /* The stack as the RUNNER sees it, which is not the stack the last render
     saw. `advance` only commits on React's own schedule — a macrotask away —
     while a queued ⌘Z picks its entry on the microtask right after the write
     it waited for lands. A ref assigned during render is still pre-advance at
     that moment, so a double-tap would pick, and run, the entry it just undid:
     the second run refuses with `conflict:` and the catch stales the whole
     stack. So every action lands here first, synchronously, and goes to the
     reducer after; both apply the same actions in the same order, and the ref
     is never written from render, where a half-flushed batch could rewind it. */
  const undoStateRef = useRef(undoStack.emptyUndo);
  const undoDispatch = useCallback((a: UndoAction) => {
    // mint the id before the split: `push` mints its own when the entry
    // carries none, and the two copies would each get a different one
    const act: UndoAction =
      a.t === "push" && a.entry.id === undefined
        ? { t: "push", entry: { ...a.entry, id: undoStack.nextUndoId() } }
        : a;
    undoStateRef.current = undoReducer(undoStateRef.current, act);
    reduce(act);
  }, []);

  /* `skipped` is the entry the keystroke walked past — the whole entry, not
     its label, because the notice has to name the RIGHT cause: an entry goes
     stale either because somebody else wrote its paths or because its own
     inverse threw, and calling the second one a disk conflict sends the
     reader hunting a sync problem that never happened.

     It rides the SUCCESS toast rather than a second one, because the app has
     a single toast slot and a notice shown before the write would be replaced
     by "Undid …" the moment the write landed. Read the two together and the
     surprise is explained in the same breath as the action: the newest edit
     could not be taken back, so an older one was. */
  const runOne = useCallback(
    async (picked: UndoRun | null, dir: -1 | 1) => {
      const entry = picked?.entry ?? null;
      const skipped = picked?.skipped;
      if (!entry) return;
      const run = dir === -1 ? entry.undo : entry.redo;
      if (!run) return;
      try {
        await run();
        undoDispatch({ t: "advance", id: entry.id, dir });
        const done = dir === -1 ? `Undid ${entry.label}` : `Redid ${entry.label}`;
        showToast(
          skipped
            ? `Skipped ${skipped.label} — ${undoStack.staleBecause(skipped)}. ${done}`
            : done
        );
        // our own write — refresh directly so the echo window covers it
        refresh();
      } catch (e) {
        const msg = errText(e);
        if (msg.includes("conflict:")) {
          undoDispatch({ t: "invalidateAll" });
          showToast(`Can't undo ${entry.label} — it changed on disk`);
        } else {
          // not a conflict — the write itself broke (file gone, permissions,
          // backend down). advance() deliberately never runs on failure, so
          // without this the same dead entry stays at the cursor and every
          // later ⌘Z re-runs it: one failure would jam undo for the session.
          undoDispatch({ t: "markStale", id: entry.id });
          showToast(`Undo failed: ${msg}`);
        }
      }
    },
    [refresh, showToast, undoDispatch]
  );

  /* One request at a time, in the order the keystrokes arrived. */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const runUndoEntry = useCallback(
    (select: () => UndoRun | null, dir: -1 | 1): Promise<void> => {
      /* Queued, not dropped. A burst of ⌘Z — key repeat, or two chords inside
         one frame — used to lose every press that arrived while a write was
         in flight, because the cursor only moves once the write lands. So a
         request waits its turn and picks its entry when that turn comes: the
         second press of a double-tap undoes the entry BELOW the first, rather
         than re-running the same one or vanishing. */
      const turn = chain.current.then(() => runOne(select(), dir));
      chain.current = turn.catch(() => {});
      return turn;
    },
    [runOne]
  );

  const undoApi = useMemo<UndoApi>(
    () => ({
      record: (entry) => undoDispatch({ t: "push", entry }),
      // the toast's Undo button and ⌘Z run the identical entry, not two
      // lookalike closures that could drift apart — and once the keystroke has
      // taken that entry back, the button on the toast still on screen finds
      // nothing to run rather than reverting it a second time
      runById: (id) => {
        void runUndoEntry(() => ({ entry: undoStack.pendingById(undoStateRef.current, id) }), -1);
      },
      evictScope: (scope) => undoDispatch({ t: "evictScope", scope }),
    }),
    [runUndoEntry, undoDispatch]
  );

  return { undoState, undoDispatch, undoStateRef, runUndoEntry, undoApi };
}
