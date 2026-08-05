import { useCallback, useMemo, useReducer, useRef } from "react";
import * as undoStack from "../lib/undo";
import type { UndoEntry, UndoState } from "../lib/undo";
import type { UndoApi } from "../lib/undoContext";
import type { ToastAction } from "./useToast";

/* The session undo stack lives here, in one reducer, because ⌘Z is
   global: whichever surface made the edit, the keystroke arrives at the
   document. The pure moves are in lib/undo.ts; this is only their dispatch. */
export type UndoAction =
  | { t: "push"; entry: Omit<UndoEntry, "id"> }
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
  const [undoState, undoDispatch] = useReducer(undoReducer, undoStack.emptyUndo);
  const undoStateRef = useRef(undoState);
  undoStateRef.current = undoState;
  const undoBusy = useRef(false);

  const runUndoEntry = useCallback(
    async (entry: UndoEntry | null, dir: -1 | 1) => {
      if (!entry || undoBusy.current) return;
      const run = dir === -1 ? entry.undo : entry.redo;
      if (!run) return;
      undoBusy.current = true;
      try {
        await run();
        undoDispatch({ t: "advance", id: entry.id, dir });
        showToast(dir === -1 ? `Undid ${entry.label}` : `Redid ${entry.label}`);
        // our own write — refresh directly so the echo window covers it
        refresh();
      } catch (e) {
        const msg = String(e);
        if (msg.includes("conflict:")) {
          undoDispatch({ t: "invalidateAll" });
          showToast(`Can't undo ${entry.label} — it changed on disk`);
        } else {
          // not a conflict — the write itself broke (file gone, permissions,
          // backend down). advance() deliberately never runs on failure, so
          // without this the same dead entry stays at the cursor and every
          // later ⌘Z re-runs it: one failure would jam undo for the session.
          undoDispatch({ t: "markStale", id: entry.id });
          showToast(`Undo failed: ${msg.replace(/^Error:\s*/, "")}`);
        }
      } finally {
        undoBusy.current = false;
      }
    },
    [refresh, showToast]
  );

  const undoApi = useMemo<UndoApi>(
    () => ({
      record: (entry) => undoDispatch({ t: "push", entry }),
      // the toast's Undo button and ⌘Z run the identical entry, not two
      // lookalike closures that could drift apart
      runById: (id) => {
        void runUndoEntry(undoStack.byId(undoStateRef.current, id), -1);
      },
    }),
    [runUndoEntry]
  );

  return { undoState, undoDispatch, undoStateRef, runUndoEntry, undoApi };
}
