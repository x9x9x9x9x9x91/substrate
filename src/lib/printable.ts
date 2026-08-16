/** Whether the surface on screen can print itself, and how.
 *
 * Print is a per-dashboard button (`DashPrintButton`), on the kinds portable
 * enough to look right on paper — eight of them, not all. The palette wants
 * the same capability as a row, because ⌘P opens the palette everywhere and
 * the muscle-memory press should land next to printing rather than nowhere.
 *
 * Module state, not a second list: the button itself registers while it is
 * mounted, so "this surface prints" has exactly one source of truth. A
 * hand-kept catalogue of printable kinds in App would drift the first time a
 * dashboard gains or loses the button.
 *
 * Registration is last-one-wins, and an unregister only clears the slot it
 * still owns — so a pane mounting before the old one unmounts cannot be
 * blanked by its predecessor's cleanup.
 */

let printer: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** The active surface's print action, or null when nothing on screen prints. */
export function getPrintable(): (() => void) | null {
  return printer;
}

export function subscribePrintable(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Claim the slot for a mounted printable pane. Returns the cleanup. */
export function registerPrintable(fn: () => void): () => void {
  printer = fn;
  notify();
  return () => {
    if (printer !== fn) return;
    printer = null;
    notify();
  };
}

/** Test-only reset so one spec's pane never leaks into the next. */
export function resetPrintableForTests(): void {
  printer = null;
  listeners.clear();
}
