import { test } from "node:test";
import assert from "node:assert/strict";
import { scanMdBlocks, type MdBlock } from "./mdblocks.ts";

// print's reading and the hub's reading, named once so every case says which
// surface it is speaking for
const PRINT = { splitListsOnMarkerFlip: true };
const HUB = { splitListsOnMarkerFlip: false };

const kinds = (blocks: MdBlock[]) => blocks.map((b) => b.kind);

test("blocks come back in reading order, one per construct", () => {
  const md = ["# Title", "", "text", "", "---", "", "> quoted", "", "- a"].join("\n");
  assert.deepEqual(kinds(scanMdBlocks(md, PRINT)), [
    "heading",
    "para",
    "hr",
    "quote",
    "list",
  ]);
});

test("a paragraph keeps its lines apart — the surface owns the soft break", () => {
  const [block] = scanMdBlocks("one\ntwo\n", PRINT);
  assert.equal(block.kind, "para");
  assert.deepEqual(block.kind === "para" ? block.lines : null, ["one", "two"]);
});

test("heading level is carried, not applied", () => {
  const blocks = scanMdBlocks("# one\n###### six\n####### seven\n", PRINT);
  assert.deepEqual(kinds(blocks), ["heading", "heading", "para"]);
  assert.equal(blocks[0].kind === "heading" ? blocks[0].level : null, 1);
  assert.equal(blocks[1].kind === "heading" ? blocks[1].level : null, 6);
});

test("a fence keeps its first word and its tail apart", () => {
  // the tail is what tells a live ```calendar from a ```calendar month that is
  // only prose — dropping it would let a widget's config reach the index
  const blocks = scanMdBlocks("```calendar month\nx\n```\n", PRINT);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].kind === "fence");
  if (blocks[0].kind !== "fence") return;
  assert.equal(blocks[0].lang, "calendar");
  assert.equal(blocks[0].tail, " month");
  assert.equal(blocks[0].inner, "x");
});

test("lang is verbatim — case folding is the caller's rule, per language", () => {
  const [block] = scanMdBlocks("```CSV\na,b\n```\n", PRINT);
  assert.equal(block.kind === "fence" ? block.lang : null, "CSV");
});

test("a spaced info string does not demote the opener", () => {
  // ```js title=x must stay an opener, or its closing ``` becomes the opener
  // of a fence that swallows the rest of the note
  const blocks = scanMdBlocks("```js title=x\ncode\n```\n\nafter\n", PRINT);
  assert.deepEqual(kinds(blocks), ["fence", "para"]);
  assert.equal(blocks[0].kind === "fence" ? blocks[0].inner : null, "code");
});

test("an unterminated fence runs to the end of the note", () => {
  // to the very end, trailing blank line included — an author who is still
  // typing the fence sees the rest of the note as its contents, which is what
  // makes the missing ``` obvious on the page
  const [block] = scanMdBlocks("```\nstill open\n", PRINT);
  assert.equal(block.kind === "fence" ? block.inner : null, "still open\n");
});

test("a quote comes back as its own text, for the caller to scan again", () => {
  const [block] = scanMdBlocks("> outer\n> > inner\n", PRINT);
  assert.equal(block.kind === "quote" ? block.inner : null, "outer\n> inner");
});

test("a table's cells are trimmed and a short row stays short", () => {
  const md = ["| a | b |", "| --- | :-: |", "| 1 | 2 |", "| only |"].join("\n");
  const [block] = scanMdBlocks(md, PRINT);
  assert.ok(block.kind === "table");
  if (block.kind !== "table") return;
  assert.deepEqual(block.head, ["a", "b"]);
  assert.deepEqual(block.rows, [["1", "2"], ["only"]]);
});

test("a pipe line without a divider under it is a paragraph", () => {
  assert.deepEqual(kinds(scanMdBlocks("| a | b |\n| c | d |\n", PRINT)), ["para"]);
});

test("list items arrive with marker and checkbox stripped", () => {
  const md = ["- plain", "- [ ] open", "- [x] done", "- [X] done too"].join("\n");
  const [block] = scanMdBlocks(md, PRINT);
  assert.ok(block.kind === "list");
  if (block.kind !== "list") return;
  assert.equal(block.ordered, false);
  assert.deepEqual(block.items, [
    { text: "plain", done: null },
    { text: "open", done: false },
    { text: "done", done: true },
    { text: "done too", done: true },
  ]);
});

test("ordered is the marker kind of the run's FIRST line", () => {
  assert.equal(
    scanMdBlocks("1. one\n2) two\n", PRINT).map((b) => (b.kind === "list" ? b.ordered : null))[0],
    true
  );
  assert.equal(
    scanMdBlocks("* star\n+ plus\n", PRINT).map((b) => (b.kind === "list" ? b.ordered : null))[0],
    false
  );
});

test("marker flip: print splits the run, the hub does not", () => {
  // the one place the two copies of this walk disagreed. Print splits because
  // an <ol> that swallowed the bullets would print them as numbers; the hub
  // never re-marks the items it consumes, so for it the run is one list.
  const md = ["- a", "- b", "1. c", "- d"].join("\n");

  const split = scanMdBlocks(md, PRINT);
  assert.deepEqual(kinds(split), ["list", "list", "list"]);
  assert.deepEqual(
    split.map((b) => (b.kind === "list" ? b.ordered : null)),
    [false, true, false]
  );
  assert.deepEqual(
    split.map((b) => (b.kind === "list" ? b.items.map((i) => i.text) : null)),
    [["a", "b"], ["c"], ["d"]]
  );

  const whole = scanMdBlocks(md, HUB);
  assert.deepEqual(kinds(whole), ["list"]);
  assert.deepEqual(
    whole[0].kind === "list" ? whole[0].items.map((i) => i.text) : null,
    ["a", "b", "c", "d"]
  );
});

test("everything else scans identically under both readings", () => {
  const md = [
    "# H",
    "",
    "para one",
    "para two",
    "",
    "```csv",
    "a,b",
    "```",
    "",
    "> quoted",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "***",
    "",
    "- [ ] task",
  ].join("\n");
  assert.deepEqual(scanMdBlocks(md, PRINT), scanMdBlocks(md, HUB));
});

test("CRLF is the caller's business — the scanner splits on \\n only", () => {
  // print normalizes its input first (print.ts strips \r\n); the hub hands the
  // note body over verbatim. A stray \r therefore rides along in the text
  // rather than being swallowed — whoever cares about it owns the strip.
  const [block] = scanMdBlocks("plain\r\n", PRINT);
  assert.deepEqual(block.kind === "para" ? block.lines : null, ["plain\r"]);
});
