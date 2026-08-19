import { test } from "node:test";
import assert from "node:assert/strict";
import type { EditorView } from "@codemirror/view";
import { focusIntoState, setEditorFocus } from "./editorfocus.ts";

/** A view that only knows about focus: `focus()` is what makes `hasFocus`
    true, so the order the helper does the two things in is observable. */
function stubView(takesFocus: boolean) {
  const calls: string[] = [];
  let focused = false;
  const view = {
    focus() {
      calls.push("focus");
      focused = takesFocus;
    },
    get hasFocus() {
      calls.push(`hasFocus:${focused}`);
      return focused;
    },
  };
  return { view: view as unknown as EditorView, calls };
}

test("focusIntoState focuses first, then reports the focus as an effect", () => {
  const { view, calls } = stubView(true);
  const effects = focusIntoState(view);
  assert.deepEqual(calls, ["focus", "hasFocus:true"]);
  assert.equal(effects.length, 1);
  assert.ok(effects[0].is(setEditorFocus));
  assert.equal(effects[0].value, true);
});

test("focusIntoState claims nothing when the focus did not take", () => {
  const { view } = stubView(false);
  assert.deepEqual(focusIntoState(view), []);
});
