import { test } from "node:test";
import assert from "node:assert/strict";

// pdfviewer.ts reaches ipc.ts through its asset lookups, and that module reads
// `window` at load — shim a bare one before importing, the way the other unit
// tests over this layer do.
(globalThis as Record<string, unknown>).window = {};

const { pdfHostWidth } = await import("./pdfviewer.ts");

test("the editor measures the column, not the box the page is about to fill", () => {
  // the editor's wrap is inline-block: it shrink-wraps an empty frame, so the
  // host reports a few hundred pixels while the column is far wider. Reading
  // the host first is how every page in every note ends up drawn at ~300px.
  assert.equal(pdfHostWidth(300, 820, "parent"), 820);
  // the host is still the fallback for a parent that measures nothing
  assert.equal(pdfHostWidth(300, 0, "parent"), 300);
});

test("a pane measures its own host, whose parent carries the padding", () => {
  assert.equal(pdfHostWidth(760, 800, "host"), 760);
  assert.equal(pdfHostWidth(0, 800, "host"), 800);
});

test("nothing measurable is zero, not a guess", () => {
  assert.equal(pdfHostWidth(0, 0, "parent"), 0);
  assert.equal(pdfHostWidth(0, 0, "host"), 0);
});
