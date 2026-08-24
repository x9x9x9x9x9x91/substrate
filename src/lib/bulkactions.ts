/* One canonical set of actions for a live row selection, and the slot the
   pane holding that selection publishes into.

   The bulk bar under a table used to define its own buttons inline, so the
   selection existed only for the surface that drew it: the palette, which is
   the keyboard route to everything else in the app, had nothing to say about
   a selection at all. These descriptors are the same move `buildNoteActions`
   makes for a single note — one list, rendered by whatever surface can wire
   the handlers, so a new action lands in every door at once and no two doors
   can drift apart on a label or an order.

   Icon names resolve through BulkActionGlyph (components/Icons.tsx) so this
   module stays UI-free and node-testable, exactly like the note actions.

   The slot below is the printable-surface idiom (lib/printable.ts): module
   state a mounted pane claims, last-one-wins, and an unregister that only
   clears the slot it still owns — so a pane mounting before the old one
   unmounts cannot be blanked by its predecessor's cleanup. The palette reads
   it through `useSyncExternalStore`; nothing else has to thread a selection
   up through the app's tree to reach it. */

export type BulkActionIcon = "prop" | "clear" | "trash";

export interface BulkAction {
  id: string;
  label: string;
  icon: BulkActionIcon;
  hint?: string;
  destructive?: boolean;
  separatorAbove?: boolean;
  run: () => void;
}

export interface BulkActionHandlers {
  /** how many rows the selection holds — zero means there is no selection
      and no action, which is what keeps an empty bulk section out of the
      palette without every reader repeating the check */
  count: number;
  /** open the column picker over the selection. The pane opens its own
      editor, so the property write rides the pane's undoable bulk path
      whichever surface asked for it. */
  setProperty?: () => void;
  trash?: () => void;
  clearSelection?: () => void;
}

export function buildBulkActions(h: BulkActionHandlers): BulkAction[] {
  const out: BulkAction[] = [];
  if (h.count <= 0) return out;
  if (h.setProperty)
    out.push({ id: "prop", label: "Set property…", icon: "prop", run: h.setProperty });
  if (h.clearSelection)
    out.push({ id: "clear", label: "Clear selection", icon: "clear", run: h.clearSelection });
  // the destructive lane, last and separated — the note actions' convention,
  // carrying the same "recoverable" promise the Trash keeps
  if (h.trash)
    out.push({
      id: "trash",
      label: "Move to Trash",
      icon: "trash",
      hint: "recoverable",
      destructive: true,
      separatorAbove: true,
      run: h.trash,
    });
  return out;
}

let selection: BulkActionHandlers | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of [...listeners]) fn();
}

/** The live selection's handlers, or null when nothing is selected anywhere. */
export function getBulkSelection(): BulkActionHandlers | null {
  return selection;
}

export function subscribeBulkSelection(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Claim the slot for a pane holding a live selection. Returns the cleanup.
    Pass a NEW object whenever the count changes: readers compare identity. */
export function registerBulkSelection(h: BulkActionHandlers): () => void {
  selection = h;
  notify();
  return () => {
    if (selection !== h) return;
    selection = null;
    notify();
  };
}

/** Test-only reset so one spec's pane never leaks into the next. */
export function resetBulkSelectionForTests(): void {
  selection = null;
  listeners.clear();
}
