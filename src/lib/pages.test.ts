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
      { label: "Releases", view: "release", query: "status:live", sort: "released:desc", limit: 5, columns: ["title", "status", "artist"] },
      { label: "Pinned", saved: "umbra-unreleased", limit: "3" },
    ],
  });
  assert.deepEqual(pages, [
    { kind: "note", label: "Statements", note: "Label Statements" },
    {
      kind: "view",
      label: "Releases",
      spec: {
        type: "release",
        query: "status:live",
        sort: { key: "released", dir: -1 },
        limit: 5,
        columns: ["title", "status", "artist"],
      },
    },
    { kind: "saved", label: "Pinned", spec: { saved: "umbra-unreleased", limit: 3 } },
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

test("malformed workbook view options become an error page in place", () => {
  const pages = parsePages({
    pages: [
      { label: "Bad sort", view: "release", sort: "" },
      { label: "Bad columns", saved: "pin", columns: ["status", 3] },
      { label: "Fine", view: "release", limit: 2 },
    ],
  });
  assert.equal(pages[0].kind, "error");
  assert.equal(pages[1].kind, "error");
  assert.deepEqual(pages[2], {
    kind: "view",
    label: "Fine",
    spec: { type: "release", limit: 2 },
  });
});

test("workbook values cannot inject parser lines, and legacy non-string query stays ignored", () => {
  const pages = parsePages({
    pages: [
      { label: "Injected", view: "release", query: "status:live\nlimit: 1" },
      { label: "Injected list", view: "release", columns: ["status\nlimit: 1"] },
      { label: "Multiline target", view: "release\nsaved: other" },
      { label: "Legacy query", view: "release", query: 2026, limit: 2 },
    ],
  });
  assert.equal(pages[0].kind, "error");
  assert.equal(pages[1].kind, "error");
  assert.equal(pages[2].kind, "error");
  assert.deepEqual(pages[3], {
    kind: "view",
    label: "Legacy query",
    spec: { type: "release", limit: 2 },
  });
});

test("a cased Pages: key still makes tabs (SUB-921)", () => {
  const pages = parsePages({ Pages: [{ label: "S", note: "Sheet" }] });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], { kind: "note", label: "S", note: "Sheet" });
});
