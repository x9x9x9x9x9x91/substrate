/** The undo stack as a readable list (docs/undo.md §6.5).
 *
 *  What is worth pinning is what the popover SAYS: the actions in the order
 *  ⌘Z would reach them, the mark on the ones it will walk past, and the fact
 *  that exactly one row acts. The rows are built by `undoMenuItems` and drawn
 *  by the same ContextMenu every other point-anchored menu uses, so the test
 *  renders that pair and reads the DOM they produce. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";

/* Dynamic, after the harness has installed the DOM globals and the loader
   that can execute a `.tsx` at all — the pattern every component test uses. */
const { emptyUndo, push, invalidate, __resetUndoIds } = await import("./undo.ts");
const { undoMenuItems, UNDO_MENU_LIMIT } = await import("./undomenu.ts");
const { default: ContextMenu } = await import("../components/ContextMenu.tsx");

const noop = async () => {};

/** the undo stack's own fixture shape (undo.test.ts) — one path, one label */
function entry(over: Partial<Parameters<typeof push>[1]> = {}) {
  return {
    label: "edit",
    scope: "vault" as const,
    at: 0,
    paths: ["A.md"],
    undo: noop,
    redo: noop,
    ...over,
  };
}

/** a stack of `labels`, oldest first, as the app would have recorded them */
function stackOf(labels: string[]) {
  __resetUndoIds();
  let s = emptyUndo;
  for (const label of labels) s = push(s, entry({ label, paths: [`${label}.md`] }));
  return s;
}

type Row = { label: string; hint: string; disabled: boolean };

function rows(r: Awaited<ReturnType<typeof renderComponent>>): Row[] {
  return r.all(".ctx-item").map((el) => ({
    label: el.querySelector(".ctx-label")?.textContent ?? "",
    hint: el.querySelector(".ctx-hint")?.textContent ?? "",
    disabled: el.className.includes("disabled"),
  }));
}

async function open(t: Parameters<typeof renderComponent>[0], items: ReturnType<typeof undoMenuItems>) {
  return renderComponent(t, h(ContextMenu, { x: 10, y: 10, items, onClose: () => {} }));
}

test("the list reads newest first and only the next ⌘Z acts", async (t) => {
  const state = stackOf(["one", "two", "three"]);
  const ran: number[] = [];
  const r = await open(t, undoMenuItems({ state, undoHint: "⌘Z", runById: (id) => ran.push(id) }));

  assert.deepEqual(
    rows(r).map((row) => row.label),
    ["three", "two", "one"],
    "the newest action is the one ⌘Z would take back, so it leads"
  );
  assert.deepEqual(
    rows(r).map((row) => row.hint),
    ["⌘Z", "", ""],
    "the keycap marks the row the keystroke would run — and only that row"
  );
  assert.deepEqual(
    rows(r).map((row) => row.disabled),
    [false, true, true],
    "reading, not undo-to-here: every row below the top is inert"
  );

  await r.click(r.all(".ctx-item")[0]);
  assert.deepEqual(
    ran,
    [state.entries[2].id],
    "the top row runs exactly the entry it names, by id — the stack can move under an open menu"
  );
  await r.click(r.all(".ctx-item")[1]);
  assert.deepEqual(ran, [state.entries[2].id], "a lower row does nothing at all");
});

test("an entry an external write staled wears the reason it went stale", async (t) => {
  // "two" changed on disk; ⌘Z walks past it onto "one"
  const state = invalidate(stackOf(["one", "two"]), ["two.md"]);
  const r = await open(t, undoMenuItems({ state, undoHint: "⌘Z", runById: () => {} }));

  assert.deepEqual(rows(r), [
    { label: "two", hint: "changed on disk", disabled: true },
    { label: "one", hint: "⌘Z", disabled: false },
  ]);
});

test("a failed inverse is marked apart from a disk conflict", async (t) => {
  const { markStale } = await import("./undo.ts");
  const state = stackOf(["one", "two"]);
  const state2 = markStale(state, state.entries[1].id);
  const r = await open(t, undoMenuItems({ state: state2, undoHint: "⌘Z", runById: () => {} }));

  assert.equal(
    rows(r)[0].hint,
    "undo failed",
    "a write that errored is not a note somebody else changed"
  );
});

test("an empty stack says so rather than opening a blank menu", async (t) => {
  const r = await open(t, undoMenuItems({ state: emptyUndo, runById: () => {} }));
  assert.deepEqual(rows(r), [{ label: "Nothing to undo yet", hint: "", disabled: true }]);
});

test("a deep stack is cut to a glance, newest end kept", async (t) => {
  const labels = Array.from({ length: UNDO_MENU_LIMIT + 5 }, (_, i) => `e${i}`);
  const r = await open(t, undoMenuItems({ state: stackOf(labels), runById: () => {} }));

  const shown = rows(r).map((row) => row.label);
  assert.equal(shown.length, UNDO_MENU_LIMIT);
  assert.equal(shown[0], labels[labels.length - 1], "the newest action is still first");
  assert.equal(shown[shown.length - 1], labels[labels.length - UNDO_MENU_LIMIT]);
});
