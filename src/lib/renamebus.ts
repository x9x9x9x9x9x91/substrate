/* How an undone/redone rename reaches the pane that has the note
   open. The undo closure runs outside any component (vaultRename directly),
   so without an announce the path change arrives as an ordinary prop change
   and takes the full teardown+remount — the exact keystroke-loss gap the
   relabel shape closed for the pane's own renames. Panes subscribe
   while mounted; the one whose open note moved claims the announce and
   relabels in place. A module-level bus rather than a threaded ref because
   two NotePanes can be mounted at once (main pane + db-note overlay). */

type RenameHandler = (from: string, to: string) => boolean;

const handlers = new Set<RenameHandler>();

/** subscribe a mounted pane; returns the unsubscribe for effect cleanup */
export function onRenameAnnounce(handler: RenameHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** true when a mounted pane held the note and relabeled in place */
export function announceRename(from: string, to: string): boolean {
  for (const handler of handlers) {
    if (handler(from, to)) return true;
  }
  return false;
}
