import { test } from "node:test";
import assert from "node:assert/strict";
import { anchoredToggle, rangePaths, togglePath } from "./bulkselect.ts";

// a flat `rows` sequence like the pane's — grouped tables concatenate their
// sections into one array, so indices 2..3 below cross a section boundary
const rows = ["a.md", "b.md", "c.md", "d.md", "e.md"].map((path) => ({ path }));
const paths = (s: Set<string>) => [...s].sort();

test("rangePaths: forward range is inclusive on both ends", () => {
  assert.deepEqual(paths(rangePaths(rows, 1, 3)), ["b.md", "c.md", "d.md"]);
});

test("rangePaths: backward range selects the same span as forward", () => {
  assert.deepEqual(paths(rangePaths(rows, 3, 1)), paths(rangePaths(rows, 1, 3)));
});

test("rangePaths: anchor == clicked selects exactly that row", () => {
  assert.deepEqual(paths(rangePaths(rows, 2, 2)), ["c.md"]);
});

test("rangePaths: a range across a group boundary walks flat rows indices", () => {
  // group 1 = rows 0-1, group 2 = rows 2-4 (a header row sits between them
  // in the DOM) — the range ignores the header and picks by array index
  assert.deepEqual(paths(rangePaths(rows, 1, 3)), ["b.md", "c.md", "d.md"]);
});

test("rangePaths: out-of-range indices clamp instead of throwing", () => {
  assert.deepEqual(paths(rangePaths(rows, -2, 99)), ["a.md", "b.md", "c.md", "d.md", "e.md"]);
  assert.deepEqual(paths(rangePaths([], 0, 3)), []);
});

test("togglePath: adds an unselected path, removes a selected one", () => {
  const once = togglePath(new Set(), "a.md");
  assert.deepEqual(paths(once), ["a.md"]);
  const twice = togglePath(once, "a.md");
  assert.equal(twice.size, 0);
});

test("togglePath: keeps the rest of the selection and never mutates the input", () => {
  const cur = new Set(["a.md", "b.md"]);
  const next = togglePath(cur, "c.md");
  assert.deepEqual(paths(next), ["a.md", "b.md", "c.md"]);
  assert.deepEqual(paths(cur), ["a.md", "b.md"]); // input untouched
  const dropped = togglePath(next, "b.md");
  assert.deepEqual(paths(dropped), ["a.md", "c.md"]);
});

test("anchoredToggle: an empty selection seeds the anchor, so both rows land", () => {
  // plain-click "a.md" (selection cleared, anchor set), then ⌘-click "c.md"
  assert.deepEqual(paths(anchoredToggle(new Set(), "c.md", "a.md")), ["a.md", "c.md"]);
});

test("anchoredToggle: with a selection it is a plain toggle, so rows come back out", () => {
  const both = anchoredToggle(new Set(), "c.md", "a.md");
  assert.deepEqual(paths(anchoredToggle(both, "a.md", "c.md")), ["c.md"]);
  assert.deepEqual(paths(anchoredToggle(both, "c.md", "c.md")), ["a.md"]);
  // and a third row joins rather than replacing
  assert.deepEqual(paths(anchoredToggle(both, "e.md", "c.md")), ["a.md", "c.md", "e.md"]);
});

test("anchoredToggle: ⌘-clicking the anchor itself just selects that one row", () => {
  assert.deepEqual(paths(anchoredToggle(new Set(), "a.md", "a.md")), ["a.md"]);
});

test("anchoredToggle: no anchor (fresh table, or renamed away) selects only the clicked row", () => {
  assert.deepEqual(paths(anchoredToggle(new Set(), "c.md", null)), ["c.md"]);
});

test("anchoredToggle: never mutates the selection it was given", () => {
  const cur = new Set(["a.md"]);
  anchoredToggle(cur, "c.md", "e.md");
  assert.deepEqual(paths(cur), ["a.md"]);
});
