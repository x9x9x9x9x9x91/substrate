import { test } from "node:test";
import assert from "node:assert/strict";
import { gridCardSharpIndices, gridSpans, parseGridBlocks } from "./grid.ts";

test("parses cards, chart and view tiles in fence order", () => {
  const blocks = parseGridBlocks(`before
\`\`\`tile
tile: cards
source: {{Holdings}}
cards: Total value = total | usd | emph | digits=2, Crypto = crypto | usd
\`\`\`
\`\`\`tile
tile: chart
source: release
x: released:month
y: count
kind: bar
span: 2
\`\`\`
\`\`\`tile
tile: view
type: release
query: status:mastering
\`\`\``);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], {
    tile: {
      kind: "cards",
      span: 1,
      cards: [
        { label: "Total value", bind: "{{Holdings.total}}", format: "usd", emph: true, digits: 2 },
        { label: "Crypto", bind: "{{Holdings.crypto}}", format: "usd" },
      ],
    },
    error: null,
  });
  assert.equal(blocks[1].tile?.kind, "chart");
  assert.equal(blocks[1].tile?.span, 2);
  assert.deepEqual(blocks[2], {
    tile: { kind: "view", span: 1, view: { type: "release", query: "status:mastering" } },
    error: null,
  });
});

test("a tile card takes an accent token, off-roster names left absent (SUB-969)", () => {
  const [block] = parseGridBlocks(
    "```tile\ntile: cards\nsource: {{Holdings}}\ncards: A = total | accent:teal, B = etf | usd | accent:Violet\n```"
  );
  assert.deepEqual(block.tile?.kind === "cards" ? block.tile.cards : null, [
    { label: "A", bind: "{{Holdings.total}}", accent: "teal" },
    { label: "B", bind: "{{Holdings.etf}}", format: "usd", accent: "violet" },
  ]);
  // the prefix is what marks a style token, so a bad colour is not a bad
  // option: the card still reads its number
  for (const raw of ["accent:#14b8a6", "accent:2px", "accent:tealish", "accent:"]) {
    const [bad] = parseGridBlocks(
      `\`\`\`tile\ntile: cards\nsource: {{Holdings}}\ncards: A = total | ${raw}\n\`\`\``
    );
    assert.equal(bad.error, null, raw);
    assert.deepEqual(bad.tile?.kind === "cards" ? bad.tile.cards : null, [
      { label: "A", bind: "{{Holdings.total}}", accent: undefined },
    ], raw);
  }
  // an unprefixed colour is still an unknown option, not a silent no-op
  const [typo] = parseGridBlocks(
    "```tile\ntile: cards\nsource: {{Holdings}}\ncards: A = total | teal\n```"
  );
  assert.match(typo.error ?? "", /unknown card option/);
});

test("a chart tile inherits the size token through the delegated body (SUB-969)", () => {
  const [block] = parseGridBlocks(
    "```tile\ntile: chart\nsource: release\nx: status\ny: count\nsize: tall\n```"
  );
  assert.equal(block.tile?.kind === "chart" ? block.tile.chart.size : null, "tall");
});

test("chart tiles keep chart kind separate from tile kind", () => {
  const [block] = parseGridBlocks("```tile\ntile: chart\nsource: release\nx: status\ny: count\nkind: line\n```");
  assert.equal(block.tile?.kind, "chart");
  if (block.tile?.kind === "chart") assert.equal(block.tile.chart.kind, "line");
});

test("CRLF fences and an info-string tail parse", () => {
  const [block] = parseGridBlocks("```tile compact\r\ntile: view\r\ntype: release\r\n```");
  assert.deepEqual(block, { tile: { kind: "view", span: 1, view: { type: "release" } }, error: null });
});

test("view lines and options reach the shared parser without host pre-validation", () => {
  const [empty] = parseGridBlocks("```tile\ntile: view\ntype: release\nquery:\n```");
  assert.deepEqual(empty, {
    tile: { kind: "view", span: 1, view: { type: "release" } },
    error: null,
  });
  const [prose] = parseGridBlocks("```tile\ntile: view\ntype: release\nnot a kv line\n```");
  assert.deepEqual(prose, {
    tile: null,
    error: "Not a key: value line — “not a kv line”",
  });
  const [cut] = parseGridBlocks(
    "```tile\ntile: view\ntype: release\nsort: released:desc\nlimit: 5\ncolumns: status, artist\n```"
  );
  assert.deepEqual(cut, {
    tile: {
      kind: "view",
      span: 1,
      view: {
        type: "release",
        sort: { key: "released", dir: -1 },
        limit: 5,
        columns: ["status", "artist"],
      },
    },
    error: null,
  });
});

test("malformed tiles fail independently without dropping siblings", () => {
  const blocks = parseGridBlocks(`
\`\`\`tile
tile chart
\`\`\`
\`\`\`tile
tile: view
type: release
\`\`\`
\`\`\`tile
tile: chart
source: release
x: status
\`\`\``);
  assert.match(blocks[0].error ?? "", /missing required key "tile"/);
  assert.equal(blocks[1].tile?.kind, "view");
  assert.match(blocks[2].error ?? "", /missing required key "y"/);
});

test("host and cards errors are precise", () => {
  const cases = [
    ["tile: cards\nsource: Holdings\ncards: Total = total", /source must be \{\{Sheet Name\}\}/],
    ["tile: cards\nsource: {{Holdings}}\ncards: Total total", /can't parse card/],
    ["tile: cards\nsource: {{Holdings}}\ncards: Total = total | rainbow", /unknown card option/],
    // out-of-range digits is refused here AND in the ```cards fence,
    // both through metriccards' parseCardDigits — one bound, one wording.
    [
      "tile: cards\nsource: {{Holdings}}\ncards: Total = total | digits=30",
      /card digits must be between 0 and 8/,
    ],
    ["tile: chart\nspan: 3\nsource: release\nx: status\ny: count", /span must be 1 or 2/],
    ["tile: cards\nsource: {{A}}\nsource: {{B}}\ncards: Total = total", /duplicate key "source"/],
    ["tile: cards\nsource: {{A}}\ncards: Total = total\ncards: Other = other", /duplicate key "cards"/],
    ["tile: text\nbody: hello", /tile must be cards, chart or view/],
  ] as const;
  for (const [inner, wanted] of cases) {
    const [block] = parseGridBlocks(`\`\`\`tile\n${inner}\n\`\`\``);
    assert.match(block.error ?? "", wanted);
  }
});

test("emphasis is capped across the whole board, not restarted per tile", () => {
  const blocks = parseGridBlocks(`
\`\`\`tile
tile: cards
source: {{Holdings}}
cards: A = total | emph, B = etf | emph
\`\`\`
\`\`\`tile
tile: view
type: release
\`\`\`
\`\`\`tile
tile: cards
source: {{Holdings}}
cards: C = crypto | emph, D = cash
\`\`\``);
  assert.deepEqual(gridCardSharpIndices(blocks).map((set) => [...set]), [[0, 1], [], []]);
});

/** Build n tiles with the given spans — the tile kind is irrelevant to layout. */
function tiles(...spans: (1 | 2)[]) {
  return parseGridBlocks(
    spans.map((span) => `\`\`\`tile\ntile: view\ntype: release\nspan: ${span}\n\`\`\``).join("\n")
  );
}

test("a tile left alone on its row takes the whole row", () => {
  // three singles: the third opens a row nothing else joins
  assert.deepEqual(gridSpans(tiles(1, 1, 1)), [1, 1, 2]);
  // an even board is already paired — nothing widens
  assert.deepEqual(gridSpans(tiles(1, 1, 1, 1)), [1, 1, 1, 1]);
  // a lone tile is a lone tile whether or not it is the last one: the span-2
  // can't share row one, so it wraps and strands the single before it
  assert.deepEqual(gridSpans(tiles(1, 2, 1, 1)), [2, 2, 1, 1]);
  // an authored span is never narrowed, and a full-width tile alone is fine
  assert.deepEqual(gridSpans(tiles(2)), [2]);
  assert.deepEqual(gridSpans(tiles(2, 2)), [2, 2]);
  // a single after a span-2 pair still needs the row
  assert.deepEqual(gridSpans(tiles(2, 1)), [2, 2]);
  assert.deepEqual(gridSpans([]), []);
});

test("a broken tile still occupies a cell", () => {
  // it renders its parse error in place, so it holds a column like any tile
  const blocks = parseGridBlocks("```tile\ntile: nonsense\n```\n```tile\ntile: view\ntype: release\n```");
  assert.equal(blocks[0].tile, null);
  assert.deepEqual(gridSpans(blocks), [1, 1]);
});

test("parseGridBlocks: an unclosed fence is a banner, not a silent zero", () => {
  const blocks = parseGridBlocks("```tile\ntile: view\ntype: release\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tile, null);
  assert.match(blocks[0].error ?? "", /```tile fence is never closed — add a closing ``` line/);
  assert.match(parseGridBlocks("```tile \ntile: view\n")[0]?.error ?? "", /never closed/);
});

test("parseGridBlocks: no banner over a tile the board just drew", () => {
  const config = "tile: view\ntype: release";
  for (const body of [
    "```tile\n" + config + "\n  ```\n",
    "```tile\n" + config + "\n```js\n",
    "```tile\n" + config + "\n```\n\n```ts\nconst x = 1;\n",
  ]) {
    const blocks = parseGridBlocks(body);
    assert.equal(blocks.length, 1, body);
    assert.equal(blocks[0].error, null, body);
  }
  assert.deepEqual(parseGridBlocks("~~~\n```tile\n" + config + "\n~~~\n"), []);
});
