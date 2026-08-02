import { test } from "node:test";
import assert from "node:assert/strict";

/* The suite runs under plain node (no jsdom), so the branch logic is exercised
   against a minimal stand-in that honours exactly the contract isTyping reads:
   `instanceof HTMLElement`, `tagName`, `isContentEditable`, `closest`. */
class FakeElement {
  tagName: string;
  isContentEditable: boolean;
  private ancestorClass: string | null;

  constructor(tagName: string, opts: { editable?: boolean; inside?: string } = {}) {
    this.tagName = tagName;
    this.isContentEditable = opts.editable ?? false;
    this.ancestorClass = opts.inside ?? null;
  }

  closest(selector: string): FakeElement | null {
    return this.ancestorClass !== null && selector === `.${this.ancestorClass}` ? this : null;
  }
}

(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;

const { isTyping } = await import("./dom.ts");

test("a non-element target is never typing", () => {
  assert.equal(isTyping(null), false);
  assert.equal(isTyping({} as EventTarget), false);
});

test("text fields are typing", () => {
  assert.equal(isTyping(new FakeElement("INPUT") as unknown as EventTarget), true);
  assert.equal(isTyping(new FakeElement("TEXTAREA") as unknown as EventTarget), true);
});

test("a native select is typing — it owns option typeahead and arrow keys", () => {
  // the superset behaviour (SUB-481): previously only the grid/board panes
  // guarded SELECT, so a focused picker could lose a letter to a pane shortcut
  assert.equal(isTyping(new FakeElement("SELECT") as unknown as EventTarget), true);
});

test("a contenteditable is typing", () => {
  assert.equal(
    isTyping(new FakeElement("DIV", { editable: true }) as unknown as EventTarget),
    true
  );
});

test("anything inside a CodeMirror body is typing", () => {
  assert.equal(
    isTyping(new FakeElement("SPAN", { inside: "cm-content" }) as unknown as EventTarget),
    true
  );
});

test("plain chrome is not typing — buttons, links, the surface itself", () => {
  assert.equal(isTyping(new FakeElement("BUTTON") as unknown as EventTarget), false);
  assert.equal(isTyping(new FakeElement("A") as unknown as EventTarget), false);
  assert.equal(isTyping(new FakeElement("DIV") as unknown as EventTarget), false);
});
