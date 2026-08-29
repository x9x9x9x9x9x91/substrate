import { test } from "node:test";
import assert from "node:assert/strict";
import { isTailedBareFence } from "./fences.ts";
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

test("list items arrive with marker and checkbox stripped, and their own line", () => {
  const md = ["- plain", "- [ ] open", "- [x] done", "- [X] done too"].join("\n");
  const [block] = scanMdBlocks(md, PRINT);
  assert.ok(block.kind === "list");
  if (block.kind !== "list") return;
  assert.equal(block.ordered, false);
  assert.deepEqual(block.items, [
    { text: "plain", done: null, line: 0 },
    { text: "open", done: false, line: 1 },
    { text: "done", done: true, line: 2 },
    { text: "done too", done: true, line: 3 },
  ]);
});

test("an item's line is its position in the scanned text, not in its list", () => {
  const md = ["intro prose", "", "- [ ] first", "- [ ] second"].join("\n");
  const blocks = scanMdBlocks(md, PRINT);
  const list = blocks.find((b) => b.kind === "list");
  assert.ok(list && list.kind === "list");
  if (!list || list.kind !== "list") return;
  // the offsets a LIVE renderer writes a toggle back through — they must
  // count from the top of the text the scanner was handed
  assert.deepEqual(
    list.items.map((i) => i.line),
    [2, 3]
  );
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

test("every CommonMark fence spelling opens a fence, not a paragraph", () => {
  // lezer (the editor's own grammar) recognizes all of these outside a column,
  // so a scanner that only knew ``` made the same note render two ways
  const tilde = scanMdBlocks("~~~view\nfrom: notes\n~~~\n", PRINT);
  assert.deepEqual(kinds(tilde), ["fence"]);
  assert.equal(tilde[0].kind === "fence" ? tilde[0].lang : null, "view");
  assert.equal(tilde[0].kind === "fence" ? tilde[0].inner : null, "from: notes");

  // a run longer than three is the expensive one: the short closer never
  // fires, so the rest of the note used to read as prose after it
  const long = scanMdBlocks("````view\nfrom: notes\n````\n\nafter\n", PRINT);
  assert.deepEqual(kinds(long), ["fence", "para"]);
  assert.equal(long[0].kind === "fence" ? long[0].lang : null, "view");

  // a backtick opener's info string may not itself contain a backtick
  assert.deepEqual(kinds(scanMdBlocks("``` ``a``\n", PRINT)), ["para"]);

  // CommonMark strips the info string's leading whitespace before reading the
  // language, and so does lezer — "``` view" drew the widget in the editor and
  // printed as a config box here, which is the same note rendering two ways
  const spaced = scanMdBlocks("```  view\nfrom: notes\n```\n", PRINT);
  assert.deepEqual(kinds(spaced), ["fence"]);
  assert.equal(spaced[0].kind === "fence" ? spaced[0].lang : null, "view");
  assert.equal(spaced[0].kind === "fence" ? spaced[0].tail : null, "");

  // the tail keeps its own meaning: a second word after a spaced info word is
  // still a tail, so a bare-form lang spelled that way is still prose
  const spacedTail = scanMdBlocks("~~~ calendar month\nx\n~~~\n", PRINT);
  assert.equal(spacedTail[0].kind === "fence" ? spacedTail[0].lang : null, "calendar");
  assert.equal(spacedTail[0].kind === "fence" ? spacedTail[0].tail : null, " month");
  assert.equal(isTailedBareFence("calendar", " month"), true);
});

test("an indented fence is a fence, and its body loses the opener's indent", () => {
  const blocks = scanMdBlocks("  ```chart\n  type: bar\n  ```\n", PRINT);
  assert.deepEqual(kinds(blocks), ["fence"]);
  assert.equal(blocks[0].kind === "fence" ? blocks[0].lang : null, "chart");
  // the opener's own two spaces come off every body line — CommonMark's rule,
  // and what keeps the config parseable rather than uniformly shifted
  assert.equal(blocks[0].kind === "fence" ? blocks[0].inner : null, "type: bar");
  // four spaces is an indented code block, not a fence opener
  assert.deepEqual(kinds(scanMdBlocks("    ```chart\n", PRINT)), ["para"]);
});

test("a fence under a list item ends the list and comes back as a fence", () => {
  const blocks = scanMdBlocks("- item\n  ```chart\n  type: bar\n  ```\n", PRINT);
  assert.deepEqual(kinds(blocks), ["list", "fence"]);
  assert.equal(blocks[1].kind === "fence" ? blocks[1].lang : null, "chart");
});

test("a closer matches its own opener's character and length", () => {
  // ``` inside a ~~~ block is content, and a short run never closes a long one
  const [block] = scanMdBlocks("~~~text\n```\nstill inside\n~~~\n", PRINT);
  assert.equal(block.kind === "fence" ? block.inner : null, "```\nstill inside");
  const [longer] = scanMdBlocks("````text\n```\nstill inside\n````\n", PRINT);
  assert.equal(longer.kind === "fence" ? longer.inner : null, "```\nstill inside");
});
