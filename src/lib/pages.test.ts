import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePages } from "./pages.ts";

test("no pages prop / not a list → no tabs", () => {
  assert.deepEqual(parsePages({}), []);
  assert.deepEqual(parsePages({ pages: "Statements" }), []);
  assert.deepEqual(parsePages({ pages: 3 }), []);
});

test("note, view, saved entries parse with labels", () => {
  const pages = parsePages({
    pages: [
      { label: "Statements", note: "Label Statements" },
      { label: "Releases", view: "release", query: "status:live" },
      { label: "Pinned", saved: "umbra-unreleased" },
    ],
  });
  assert.deepEqual(pages, [
    { kind: "note", label: "Statements", note: "Label Statements" },
    { kind: "view", label: "Releases", view: "release", query: "status:live" },
    { kind: "saved", label: "Pinned", saved: "umbra-unreleased" },
  ]);
});

test("label falls back to the target, then Page N", () => {
  const pages = parsePages({
    pages: [{ note: "Splits" }, { view: "release" }, {}],
  });
  assert.equal(pages[0].label, "Splits");
  assert.equal(pages[1].label, "release");
  assert.equal(pages[2].label, "Page 3");
});

test("malformed entries become error pages in place, siblings untouched", () => {
  const pages = parsePages({
    pages: [
      "just a string",
      { label: "Both", note: "A", view: "release" },
      { label: "Neither" },
      { label: "Fine", note: "Splits" },
    ],
  });
  assert.equal(pages.length, 4);
  assert.equal(pages[0].kind, "error");
  assert.equal(pages[1].kind, "error");
  assert.equal(pages[2].kind, "error");
  assert.deepEqual(pages[3], { kind: "note", label: "Fine", note: "Splits" });
});

test("whitespace-only targets don't count", () => {
  const pages = parsePages({ pages: [{ label: "X", note: "  " }] });
  assert.equal(pages[0].kind, "error");
});
