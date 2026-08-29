/** Focus lives in something that owns its own keys — a text field, a
    contenteditable, a CodeMirror body, or a native `<select>` (which spends
    letters on option typeahead and arrows on option movement). Every pane's
    keyboard surface gates on this so a shortcut never steals a keystroke the
    focused control was going to use (one definition, five panes). */
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

/** The same question asked of whatever holds focus RIGHT NOW.
    `isTyping` tests an event's target, which is all a key handler needs; the
    shortcut hint surfaces render from held state instead — they have no event —
    so they read the live focus to decide whether the surface-scoped chords they
    would list can actually fire. */
export function isTypingNow(): boolean {
  return isTyping(document.activeElement);
}

/** Does ⌘Z inside this target belong to the app stack rather than the field?

    Normally a focused input owns its own text history. A form that COMMITS
    AND CLEARS on Enter is the exception: after the entry lands the caret sits
    in an emptied field, and the only edit left to take back is the one that
    just went to disk. Such a form declares itself with
    `data-undo-scope="app"` (docs/undo.md §2.5) rather than the app
    hard-coding a class name per board. */
export function inAppUndoForm(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.closest('[data-undo-scope="app"]') !== null;
}
