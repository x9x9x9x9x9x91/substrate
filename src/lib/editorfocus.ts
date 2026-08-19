import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Focus mirrored into editor state, so a StateField can read it — block
 * decorations may only come from a StateField, and a StateField never sees
 * the view. The editor wires CodeMirror's own focus/blur to this effect;
 * `focusIntoState` below is for the one case that cannot wait for it. */
export const setEditorFocus = StateEffect.define<boolean>();

/** Focus the editor and hand back the effect that carries that focus into
 * state, for the caller to dispatch alongside its own change.
 *
 * CodeMirror reports focus on a 10ms timer, not synchronously, so for a few
 * frames after `view.focus()` the state still says unfocused. Anything that
 * renders differently when unfocused — a table, which is a block widget that
 * replaces its own source — stays rendered across that gap, with the cursor
 * the caller just placed buried inside a widget that has no text to put it
 * in. Keystrokes in that window land at the end of the document instead of
 * where the cursor says. Focusing first and carrying the flag in the same
 * transaction as the change closes the gap: the table is source and the new
 * cell is real by the time the first character arrives.
 *
 * Nothing is claimed if the focus did not take (another window has it, the
 * element refused it) — CodeMirror's own tracking stays the authority, and
 * it will correct this flag either way on its next focus or blur. */
export function focusIntoState(view: EditorView): StateEffect<boolean>[] {
  view.focus();
  return view.hasFocus ? [setEditorFocus.of(true)] : [];
}
