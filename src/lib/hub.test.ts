import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHub, type HubBlock } from "./hub.ts";

function kinds(blocks: HubBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

test("empty body parses to zero blocks", () => {
  assert.deepEqual(parseHub(""), []);
  assert.deepEqual(parseHub("\n\n  \n"), []);
});

test("## heading splits out a section; # and ### stay markdown", () => {
  const blocks = parseHub("intro line\n\n## Releases\n\nbody text\n### sub\n# top\n");
  assert.deepEqual(kinds(blocks), ["markdown", "section", "markdown"]);
  assert.deepEqual(blocks[1], { kind: "section", text: "Releases" });
  const tail = blocks[2];
  assert.equal(tail.kind, "markdown");
  if (tail.kind === "markdown") {
    assert.ok(tail.text.includes("### sub"), "h3 stays in the markdown flow");
    assert.ok(tail.text.includes("# top"), "h1 stays in the markdown flow");
  }
});

test("consecutive callouts group into one card row", () => {
  const body = [
    "> [!note] First",
    "> body one",
    "> [!warn] Second",
    "> body two",
    "> [!idea] Third",
    "> body three",
    "",
  ].join("\n");
  const blocks = parseHub(body);
  assert.deepEqual(kinds(blocks), ["cards"]);
  const cards = blocks[0];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.equal(cards.callouts.length, 3);
  assert.deepEqual(
    cards.callouts.map((c) => [c.kind, c.title]),
    [
      ["note", "First"],
      ["warn", "Second"],
      ["idea", "Third"],
    ]
  );
  assert.deepEqual(cards.callouts[0].body, ["body one"]);
});

test("callout kind is case-insensitive", () => {
  const blocks = parseHub("> [!NOTE] A\n> x\n> [!Warn] B\n> y\n> [!IDEA] C\n");
  const cards = blocks[0];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.deepEqual(
    cards.callouts.map((c) => c.kind),
    ["note", "warn", "idea"]
  );
});

test("callout continuation runs until a non-quote line or a new header", () => {
  const blocks = parseHub(
    "> [!note] T\n> line a\n> line b\n> [!warn] U\n> only\nplain\n"
  );
  const cards = blocks[0];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.deepEqual(cards.callouts[0].body, ["line a", "line b"]);
  assert.deepEqual(cards.callouts[1].body, ["only"]);
  // the prose line after the run is its own markdown chunk
  assert.deepEqual(kinds(blocks), ["cards", "markdown"]);
});

test("callout interrupted by prose makes two card groups", () => {
  const body = [
    "> [!note] One",
    "> a",
    "",
    "some prose between",
    "",
    "> [!warn] Two",
    "> b",
    "",
  ].join("\n");
  const blocks = parseHub(body);
  assert.deepEqual(kinds(blocks), ["cards", "markdown", "cards"]);
  const [g1, mid, g2] = blocks;
  if (g1.kind !== "cards" || g2.kind !== "cards" || mid.kind !== "markdown")
    assert.fail("shape");
  assert.equal(g1.callouts.length, 1);
  assert.equal(g2.callouts.length, 1);
  assert.ok(mid.text.includes("some prose between"));
});

test("a blank line alone also splits callouts into two groups", () => {
  const blocks = parseHub("> [!note] One\n> a\n\n> [!warn] Two\n> b\n");
  assert.deepEqual(kinds(blocks), ["cards", "cards"]);
});

test("a plain quote block is not a card group", () => {
  const blocks = parseHub("> just a quote\n> more quote\n");
  assert.deepEqual(kinds(blocks), ["markdown"]);
  const md = blocks[0];
  if (md.kind === "markdown") assert.ok(md.text.includes("> just a quote"));
});

test("callout-looking lines inside code fences are not parsed", () => {
  const body = [
    "before",
    "",
    "```md",
    "> [!note] not a callout",
    "> still code",
    "```",
    "",
    "> [!idea] real",
    "> yes",
    "",
  ].join("\n");
  const blocks = parseHub(body);
  assert.deepEqual(kinds(blocks), ["markdown", "cards"]);
  const md = blocks[0];
  if (md.kind === "markdown") assert.ok(md.text.includes("> [!note] not a callout"));
  const cards = blocks[1];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.equal(cards.callouts.length, 1);
  assert.equal(cards.callouts[0].kind, "idea");
});

test("a fence opener with a spaced info string still shields its body (SUB-898)", () => {
  const body = [
    "```rust ignore",
    "> [!note] not a callout",
    "```",
    "",
    "## After",
    "> [!idea] real",
  ].join("\n");
  const blocks = parseHub(body);
  assert.deepEqual(kinds(blocks), ["markdown", "section", "cards"]);
  const md = blocks[0];
  if (md.kind === "markdown") assert.ok(md.text.includes("> [!note] not a callout"));
});

test("CRLF bodies parse like LF bodies", () => {
  const lf = parseHub("## Sec\n\n> [!note] A\n> x\n\npara\n");
  const crlf = parseHub("## Sec\r\n\r\n> [!note] A\r\n> x\r\n\r\npara\r\n");
  assert.deepEqual(crlf, lf);
});

test("full hub layout: section, cards, prose, table stay in order", () => {
  const body = [
    "hub intro",
    "",
    "## Releases",
    "",
    "> [!note] In review",
    "> [[Slow Bloom EP]]",
    "> [!warn] Waiting",
    "> [[Vessel Songs]]",
    "",
    "linear paragraph",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
  ].join("\n");
  const blocks = parseHub(body);
  assert.deepEqual(kinds(blocks), ["markdown", "section", "cards", "markdown"]);
  const tail = blocks[3];
  if (tail.kind === "markdown") {
    assert.ok(tail.text.includes("linear paragraph"));
    assert.ok(tail.text.includes("| a | b |"));
  }
});

test("callout with no title keeps an empty title", () => {
  const blocks = parseHub("> [!note]\n> body only\n");
  const cards = blocks[0];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.equal(cards.callouts[0].title, "");
  assert.deepEqual(cards.callouts[0].body, ["body only"]);
});

test("a callout takes an accent after the kind", () => {
  const blocks = parseHub("> [!note|teal] Ship\n> body\n> [!warn|Violet] Watch\n");
  const cards = blocks[0];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.deepEqual(
    cards.callouts.map((c) => [c.kind, c.title, c.accent]),
    [
      ["note", "Ship", "teal"],
      ["warn", "Watch", "violet"],
    ]
  );
  assert.deepEqual(cards.callouts[0].body, ["body"]);
});

test("a callout takes a span after the kind, with or without an accent", () => {
  const blocks = parseHub(
    "> [!note|span:2] Wide\n> [!warn|teal|span:2] Wide and teal\n> [!idea|span:1] Narrow\n> [!note] Plain\n"
  );
  const cards = blocks[0];
  if (cards.kind !== "cards") assert.fail("want cards");
  assert.deepEqual(
    cards.callouts.map((c) => [c.title, c.accent, c.span]),
    [
      ["Wide", undefined, 2],
      ["Wide and teal", "teal", 2],
      ["Narrow", undefined, 1],
      ["Plain", undefined, undefined],
    ]
  );
});

test("an unreadable span leaves the card at its default width, not broken", () => {
  for (const tail of ["span:3", "span:50%", "span:", "span", "teal|span:wide"]) {
    const blocks = parseHub(`> [!note|${tail}] Still a note\n> body\n`);
    const cards = blocks[0];
    if (cards.kind !== "cards") assert.fail(`want cards for "${tail}"`);
    assert.equal(cards.callouts[0].kind, "note");
    assert.equal(cards.callouts[0].title, "Still a note");
    assert.equal(cards.callouts[0].span, undefined);
  }
});

test("an off-roster accent leaves a working callout, not a blockquote", () => {
  for (const tail of ["chartreuse", "#14b8a6", "", "12px"]) {
    const blocks = parseHub(`> [!note|${tail}] Still a note\n> body\n`);
    const cards = blocks[0];
    if (cards.kind !== "cards") assert.fail(`want cards for "${tail}"`);
    assert.equal(cards.callouts[0].kind, "note");
    assert.equal(cards.callouts[0].title, "Still a note");
    assert.equal(cards.callouts[0].accent, undefined);
  }
});
