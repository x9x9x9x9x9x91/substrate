/** Focus lives in something that owns its own keys — a text field, a
    contenteditable, a CodeMirror body, or a native `<select>` (which spends
    letters on option typeahead and arrows on option movement). Every pane's
    keyboard surface gates on this so a shortcut never steals a keystroke the
    focused control was going to use (SUB-481: one definition, five panes). */
export function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable ||
    el.closest(".cm-content") !== null
  );
}

/** The same question asked of whatever holds focus RIGHT NOW (SUB-498).
    `isTyping` tests an event's target, which is all a key handler needs; the
    shortcut hint surfaces render from held state instead — they have no event —
    so they read the live focus to decide whether the surface-scoped chords they
    would list can actually fire. */
export function isTypingNow(): boolean {
  return isTyping(document.activeElement);
}
