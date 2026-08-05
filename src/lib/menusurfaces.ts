/** The floating menu/popover surfaces (context menu, dots menu, select/date/
    file pickers, the calendar peek …). menuUp() probes for any of them being
    open; the app-root context-menu fallback uses the same set as a
    closest() guard so a right-click INSIDE an open popover doesn't stack the
    app menu on top of it (portaled popovers bubble to the root, not their
    logical parent pane). */
export const MENU_SURFACES =
  ".overlay, .ctx-overlay, .selmenu, .colmenu, .dots-menu, .iconpick, .cal-peek";

/** A floating menu/popover is up — destructive and navigation shortcuts stay
    out of the way. Same DOM probe as DatabasePane's Esc guard. */
export function menuUp(): boolean {
  return document.querySelector(MENU_SURFACES) !== null;
}
