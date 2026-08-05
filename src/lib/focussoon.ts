/** SUB-455: deferred auto-focus that yields to the user.
 *
 * Creating or opening a note focuses its editor (or title) ~80ms later, once
 * the pane has mounted. That delay is a window in which the user can act —
 * click another row, hit an arrow key — and the naive `setTimeout(focus)`
 * then yanks focus back out from under them. Two real consequences, both
 * caught as "flaky" e2e failures before they were understood as app bugs:
 * a keystroke aimed at the list is swallowed by CodeMirror, and text typed
 * into a fresh scratch note's body gets split into its title mid-word.
 *
 * So: schedule the focus, but cancel it the moment the user shows intent
 * elsewhere (a pointerdown or a keydown). Auto-focus is a convenience for an
 * idle user, never an override of a deliberate one.
 *
 * SUB-765: with one exception, because "intent elsewhere" over-read the
 * flagship capture moment. ⌘N on Notes and typing straight away is the whole
 * point of a scratch note — but that first keystroke cancelled the handoff,
 * and the text went nowhere (the list has no type-ahead, SUB-392), leaving
 * the note stuck unfocused and "Untitled" forever.
 *
 * The tell is whether the character had anywhere to land. A *printable* key
 * (single-char key, no ctrl/meta) pressed while focus sits on something that
 * does not take text — the body, a sidebar button, a list row — is a
 * character that is about to be dropped on the floor, so it is read as intent
 * AT the pending target: fire the pending focus synchronously inside the
 * keydown rather than cancel it. The focus lands before the browser inserts
 * the character, so that same char is typed into the newly focused field.
 * SUB-1123 counts an Option-produced character (⌥L is `@` on a German layout)
 * and a pending dead key as exactly that kind of keystroke; see below.
 *
 * Everything else keeps the old semantics exactly: non-printable and
 * command-chorded keys always cancel (SUB-455's arrow-key-at-the-list case), and
 * so does any key pressed while a real text field or editor already has focus
 * (the scratch-body-split-into-title case). pointerdown cancels
 * unconditionally — a click elsewhere is never ambiguous.
 */
export function focusSoon(run: () => void, delay = 80): () => void {
  let done = false;
  const teardown = () => {
    if (done) return false;
    done = true;
    window.clearTimeout(timer);
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("keydown", onKeydown, true);
    return true;
  };
  const cancel = () => {
    teardown();
  };
  // does the currently focused element accept typed text? if it does, the
  // keystroke belongs to it and the pending focus must yield (SUB-455)
  const takesText = (el: Element | null): boolean => {
    if (!el || typeof document === "undefined") return false;
    if (el === document.body) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    // CodeMirror's editable surface, and anything else contenteditable
    return (el as HTMLElement).isContentEditable === true;
  };
  // a bare printable key with no text target: the character is about to be
  // dropped on the floor, and the pending focus is where the user meant to be
  // — take them there now, in time for this same keystroke to land there
  const typingIntoTheVoid = (e: unknown): boolean => {
    const ev = e as Partial<KeyboardEvent> | null;
    if (!ev || typeof ev.key !== "string") return false;
    // SUB-1123: ⌘/⌃ are command modifiers; Option is NOT one on macOS — it is
    // how international layouts type ordinary characters (German: `@` is ⌥L,
    // `[` is ⌥5, `~` is ⌥N). Rejecting altKey outright cancelled the handoff on
    // an ordinary German character, i.e. the SUB-765 bug reached by typing. No
    // character list is needed: an Option chord that produces a character
    // reports THAT character in `key`, so the length test below separates ⌥L
    // ("@") from ⌥ArrowDown on its own. The app's only bare-⌥ chords are ⌥←/⌥→
    // (mini-player transport) — named keys, so they still cancel. Same fix as
    // the database cell surface (SUB-1120, cellhop.ts).
    if (ev.ctrlKey || ev.metaKey) return false;
    // a composition in progress belongs to the IME, not to a pending focus
    if (ev.isComposing) return false;
    // `key` is the produced character for printable keys and a name ("Enter",
    // "F2", "ArrowDown") for everything else — length is the whole test.
    // A dead key (`´` `` ` `` `^` bare on German/intl layouts, ⌥e/⌥i on US)
    // reports "Dead" and carries no character of its own: the browser holds it
    // and composes it with the NEXT keystroke, which can only complete inside a
    // real text field. Cancelling on it stranded the note unfocused AND lost the
    // accent; firing hands the user the field the accent is headed for. Nothing
    // here calls preventDefault, so the browser keeps the pending dead key.
    if (ev.key.length !== 1 && ev.key !== "Dead") return false;
    if (typeof document === "undefined") return false;
    return !takesText(document.activeElement);
  };
  const onKeydown = (e: Event) => {
    if (typingIntoTheVoid(e)) {
      if (teardown()) run();
      return;
    }
    cancel();
  };
  const timer = window.setTimeout(() => {
    if (done) return;
    cancel();
    run();
  }, delay);
  // capture phase: the user's intent is registered even if a handler
  // downstream stops propagation
  window.addEventListener("pointerdown", cancel, true);
  window.addEventListener("keydown", onKeydown, true);
  return cancel;
}
