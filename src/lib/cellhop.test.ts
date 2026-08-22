import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeadKey, isPrintableKey, nextEditableCell, type HopGrid } from "./cellhop.ts";
import type { PropKind } from "./types.ts";

/** 3 data columns × 4 rows, with the kinds named per column */
const gridOf = (kinds: (PropKind | undefined)[], rows = 4): HopGrid => ({
  cols: kinds.length,
  rows,
  kindAt: (i) => kinds[i],
});

const plain = gridOf([undefined, undefined, undefined]);

test("Enter walks down its own column and stops at the last row (SUB-947)", () => {
  assert.deepEqual(nextEditableCell({ c: 2, r: 0 }, "down", plain), { c: 2, r: 1 });
  assert.deepEqual(nextEditableCell({ c: 2, r: 2 }, "down", plain), { c: 2, r: 3 });
  assert.equal(nextEditableCell({ c: 2, r: 3 }, "down", plain), null);
});

test("Shift-Enter walks up and stops at the first row", () => {
  assert.deepEqual(nextEditableCell({ c: 1, r: 2 }, "up", plain), { c: 1, r: 1 });
  assert.equal(nextEditableCell({ c: 1, r: 0 }, "up", plain), null);
});

test("Tab walks right and wraps into the next row at the last column", () => {
  assert.deepEqual(nextEditableCell({ c: 1, r: 0 }, "right", plain), { c: 2, r: 0 });
  assert.deepEqual(nextEditableCell({ c: 3, r: 0 }, "right", plain), { c: 1, r: 1 });
});

test("Shift-Tab walks left and wraps into the previous row's last column", () => {
  assert.deepEqual(nextEditableCell({ c: 2, r: 1 }, "left", plain), { c: 1, r: 1 });
  assert.deepEqual(nextEditableCell({ c: 1, r: 1 }, "left", plain), { c: 3, r: 0 });
});

test("the wrap stops at the table's last and first data cell", () => {
  assert.equal(nextEditableCell({ c: 3, r: 3 }, "right", plain), null);
  assert.equal(nextEditableCell({ c: 1, r: 0 }, "left", plain), null);
});

test("a rollup column is derived, so the horizontal hop steps over it (SUB-678)", () => {
  const g = gridOf([undefined, "rollup", undefined]);
  assert.deepEqual(nextEditableCell({ c: 1, r: 0 }, "right", g), { c: 3, r: 0 });
  assert.deepEqual(nextEditableCell({ c: 3, r: 0 }, "left", g), { c: 1, r: 0 });
});

test("a rollup at a row's edge hops past it into the neighbouring row", () => {
  const g = gridOf([undefined, undefined, "rollup"]);
  assert.deepEqual(nextEditableCell({ c: 2, r: 0 }, "right", g), { c: 1, r: 1 });
});

test("an all-rollup table terminates the walk instead of looping", () => {
  const g = gridOf(["rollup", "rollup"]);
  assert.equal(nextEditableCell({ c: 1, r: 0 }, "right", g), null);
  assert.equal(nextEditableCell({ c: 2, r: 3 }, "left", g), null);
});

test("a vertical hop keeps its column even when that column is a rollup", () => {
  // rollups never open an editor to hop FROM, but the arithmetic stays honest
  const g = gridOf([undefined, "rollup"]);
  assert.deepEqual(nextEditableCell({ c: 2, r: 0 }, "down", g), { c: 2, r: 1 });
});

test("a horizontal hop from the title column enters the data columns", () => {
  assert.deepEqual(nextEditableCell({ c: 0, r: 1 }, "right", plain), { c: 1, r: 1 });
});

test("where the Name cell renames in place, the walk includes it", () => {
  const g = { ...plain, titleEditable: true };
  // Tab out of the last data column wraps onto the next row's NAME cell,
  // and Shift-Tab out of the first data column re-opens the one it came from
  assert.deepEqual(nextEditableCell({ c: 3, r: 0 }, "right", g), { c: 0, r: 1 });
  assert.deepEqual(nextEditableCell({ c: 1, r: 1 }, "left", g), { c: 0, r: 1 });
  // and the Name cell's own two neighbours are the row it sits on and the
  // row above's last column — the walk is reversible through it
  assert.deepEqual(nextEditableCell({ c: 0, r: 1 }, "right", g), { c: 1, r: 1 });
  assert.deepEqual(nextEditableCell({ c: 0, r: 1 }, "left", g), { c: 3, r: 0 });
  // the ends of the table stay the ends
  assert.equal(nextEditableCell({ c: 0, r: 0 }, "left", g), null);
  assert.equal(nextEditableCell({ c: 3, r: 3 }, "right", g), null);
});

test("a read-only Name column is stepped over like a derived one", () => {
  // no rename route behind the title: Tab walks the data columns alone,
  // exactly as it did before the Name cell could be edited at all
  assert.deepEqual(nextEditableCell({ c: 3, r: 0 }, "right", plain), { c: 1, r: 1 });
  assert.deepEqual(nextEditableCell({ c: 1, r: 1 }, "left", plain), { c: 3, r: 0 });
});

test("an empty grid has nowhere to hop", () => {
  assert.equal(nextEditableCell({ c: 1, r: 0 }, "down", gridOf([], 0)), null);
  assert.equal(nextEditableCell({ c: 1, r: 0 }, "right", gridOf([undefined], 0)), null);
});

test("type-to-replace fires on printable characters only (SUB-947)", () => {
  assert.equal(isPrintableKey({ key: "a" }), true);
  assert.equal(isPrintableKey({ key: "7" }), true);
  assert.equal(isPrintableKey({ key: "ü" }), true);
  assert.equal(isPrintableKey({ key: "€" }), true);
  assert.equal(isPrintableKey({ key: "Enter" }), false);
  assert.equal(isPrintableKey({ key: "F2" }), false);
  assert.equal(isPrintableKey({ key: "ArrowDown" }), false);
  assert.equal(isPrintableKey({ key: "Tab" }), false);
});

test("space activates rather than types, and command chords never replace", () => {
  assert.equal(isPrintableKey({ key: " " }), false);
  assert.equal(isPrintableKey({ key: "k", metaKey: true }), false);
  assert.equal(isPrintableKey({ key: "k", ctrlKey: true }), false);
  // ⌘⌥/⌃⌥ are still command chords, Option or not
  assert.equal(isPrintableKey({ key: "@", metaKey: true, altKey: true }), false);
  assert.equal(isPrintableKey({ key: "@", ctrlKey: true, altKey: true }), false);
});

test("Option-produced characters type like any other (SUB-1120)", () => {
  // German Mac layout: `@` is ⌥L, `[` is ⌥5, `~` is ⌥N, `€` is ⌥E — the chord
  // reports the produced character, so it is a character, not a shortcut
  assert.equal(isPrintableKey({ key: "@", altKey: true }), true);
  assert.equal(isPrintableKey({ key: "[", altKey: true }), true);
  assert.equal(isPrintableKey({ key: "~", altKey: true }), true);
  assert.equal(isPrintableKey({ key: "€", altKey: true }), true);
  // …while an Option chord over a NAMED key stays nav/shortcut territory
  assert.equal(isPrintableKey({ key: "ArrowDown", altKey: true }), false);
  assert.equal(isPrintableKey({ key: "Enter", altKey: true }), false);
  assert.equal(isPrintableKey({ key: "Backspace", altKey: true }), false);
  assert.equal(isPrintableKey({ key: " ", altKey: true }), false);
});

test("a composition in progress is the IME's, not a new edit (SUB-1120)", () => {
  assert.equal(isPrintableKey({ key: "e", isComposing: true }), false);
  assert.equal(isPrintableKey({ key: "Process" }), false);
});

test("a dead key opens the editor so its accent can compose (SUB-1120)", () => {
  // ´ + e → é: the dead key itself carries no character and would be swallowed
  assert.equal(isDeadKey({ key: "Dead" }), true);
  // it is not printable — the two openers are distinct, and it seeds nothing
  assert.equal(isPrintableKey({ key: "Dead" }), false);
  assert.equal(isDeadKey({ key: "e" }), false);
  assert.equal(isDeadKey({ key: "Dead", metaKey: true }), false);
  assert.equal(isDeadKey({ key: "Dead", ctrlKey: true }), false);
});
