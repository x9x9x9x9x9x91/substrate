import { createContext, useContext } from "react";
import type { UndoEntry, UndoScope } from "./undo.ts";

/* How a surface deep in the tree records an undoable action without
   every pane threading a callback down from App. The stack itself lives in
   App's useReducer; this is only the write end of it. */

export type UndoApi = {
  /** Record an action's inverse. Surfaces call this via setPropUndoable
      rather than directly. A pre-minted id is accepted so a surface's own
      "Undo" button points at the very entry ⌘Z would run. */
  record: (entry: Omit<UndoEntry, "id"> & { id?: number }) => void;
  /** Run an entry by id — what a toast's Undo button does, so the button and
      ⌘Z are the same operation rather than two lookalikes. */
  runById: (id: number) => void;
  /** Drop a pane's entries when it unmounts. A `pane:*` inverse closes over
      state the pane owns, so leaving it on the stack lets ⌘Z write on behalf
      of a surface that is no longer there (docs/undo.md §2.3). */
  evictScope: (scope: UndoScope) => void;
};

// the default is a no-op rather than a throw: tests and isolated component
// renders shouldn't have to build a provider to render a pane
export const UndoContext = createContext<UndoApi>({
  record: () => {},
  runById: () => {},
  evictScope: () => {},
});

export function useUndo(): UndoApi {
  return useContext(UndoContext);
}
