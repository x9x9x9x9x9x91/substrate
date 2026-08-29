/* The undo stack, as a list somebody can read (docs/undo.md §6.5).

   A 50-deep stack is only usable if you can see what is on it: which action
   the next ⌘Z takes back, and which ones it will walk past because the file
   moved underneath them. "Changed on disk" reads as mysterious in a toast and
   obvious in a list next to the action it happened to.

   Read-only on purpose. Exactly one row acts — the one ⌘Z would run anyway —
   and every other row is inert. Undo-to-here would have to run every inverse
   between here and there, each of which can refuse independently, and half a
   walk back is a worse place to stand than either end of it.

   Pure and node-testable: the rows are ContextMenu items, so the popover is
   the menu component the rest of the app already opens at a point. */

import type { MenuItem } from "../components/ContextMenu.tsx";
import { peekUndo, type UndoEntry, type UndoState } from "./undo.ts";

/** The mark a skipped entry wears in the list. Same two causes the ⌘Z notice
    names (`staleBecause`), said in the shorter register a trailing hint takes
    — and still said apart, because telling a reader their note changed on
    disk when a write simply errored sends them hunting a sync conflict that
    never happened. */
export function staleMark(entry: UndoEntry): string {
  return entry.stale === "failed" ? "undo failed" : "changed on disk";
}

/** how many entries the popover shows — the stack holds up to MAX_UNDO, and a
    menu longer than this is a scroll rather than a glance */
export const UNDO_MENU_LIMIT = 12;

export type UndoMenuOpts = {
  state: UndoState;
  /** the ⌘Z key label, shown against the row that keystroke would run */
  undoHint?: string;
  /** run one entry by id (the toasts' lookup): the rows are a snapshot taken
      when the menu opened, and the stack can move underneath an open menu —
      a cursor-based call here would run whatever is top NOW under a label
      that names something else. By id, the click runs exactly the action the
      row names, or nothing once that action went stale or was taken back. */
  runById: (id: number) => void;
  limit?: number;
};

/** Newest first, from the cursor down: everything at or below the cursor is
    what ⌘Z still has ahead of it. The redo side is left out — those actions
    have already been taken back, and listing them among the ones that haven't
    is the ambiguity the cursor exists to remove. */
export function undoMenuItems({ state, undoHint, runById, limit = UNDO_MENU_LIMIT }: UndoMenuOpts): MenuItem[] {
  const next = peekUndo(state);
  const rows: MenuItem[] = [];
  for (let i = state.cursor; i >= 0 && rows.length < limit; i--) {
    const e = state.entries[i];
    const live = e === next;
    rows.push({
      label: e.label,
      // the stale mark carries the recorded cause, never a guessed one: a
      // write that errored is not a note somebody else changed
      hint: e.stale ? staleMark(e) : live ? undoHint : undefined,
      // only the entry the keystroke would run is live; the rest are here to
      // be read
      disabled: !live,
      onSelect: live ? () => runById(e.id) : () => {},
    });
  }
  if (rows.length === 0)
    rows.push({ label: "Nothing to undo yet", disabled: true, onSelect: () => {} });
  return rows;
}
