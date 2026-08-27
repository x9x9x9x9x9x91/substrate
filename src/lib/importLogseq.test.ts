import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOURNAL_FOLDER,
  LOGSEQ_PAGES_FOLDER,
  bodyAssets,
  journalDay,
  logseqClassify,
  logseqParse,
  pageTarget,
  rewriteAssetRefs,
  splitPageProps,
  type ScanEntry,
} from "./importLogseq.ts";
import { buildPlan, existingStamps, skipSummary } from "./importer.ts";

const SCAN: ScanEntry[] = [
  { path: "pages/Reeds.md", size: 120 },
  { path: "pages/Work%2FClients.md", size: 80 },
  { path: "pages/Gear___Pedals.md", size: 60 },
  { path: "pages/Legacy.org", size: 200 },
  { path: "pages/Also legacy.org", size: 40 },
  { path: "journals/2026_02_01.md", size: 90 },
  { path: "journals/2026_02_02.md", size: 30 },
  { path: "journals/contents.md", size: 10 },
  { path: "assets/tide_1700000000000_0.png", size: 4096 },
  { path: "assets/unused.png", size: 512 },
  { path: "logseq/config.edn", size: 300 },
  { path: ".git/HEAD", size: 20 },
  { path: "README.txt", size: 15 },
];

test("the scan sorts a graph into pages, journals, assets and reasons", () => {
  const scan = logseqClassify(SCAN);
  assert.deepEqual(scan.pages, [
    "pages/Gear___Pedals.md",
    "pages/Reeds.md",
    "pages/Work%2FClients.md",
  ]);
  assert.deepEqual(scan.journals, [
    "journals/2026_02_01.md",
    "journals/2026_02_02.md",
    "journals/contents.md",
  ]);
  assert.equal(scan.assets.get("tide_1700000000000_0.png"), "assets/tide_1700000000000_0.png");
  // Logseq's own config and the git dir are not content and raise no skip line
  assert.ok(!scan.skips.some((s) => s.path.startsWith("logseq/") || s.path.startsWith(".git/")));
  assert.deepEqual(skipSummary(scan.skips), [
    { reason: "org-mode file — this import reads markdown only", count: 2 },
    { reason: "not a page, a journal or a referenced asset", count: 1 },
  ]);
});

test("org files are skipped and counted", () => {
  const scan = logseqClassify(SCAN);
  const org = scan.skips.filter((s) => s.path.endsWith(".org"));
  assert.equal(org.length, 2);
  assert.match(org[0].reason, /org-mode/);
});

test("leading property lines become props and leave the body", () => {
  const { props, body } = splitPageProps(
    ["title:: Reeds", "tags:: field, tape", "mood::  ", "", "- first bullet", "  - nested"].join(
      "\n"
    )
  );
  assert.deepEqual(props, [
    ["title", "Reeds"],
    ["tags", "field, tape"],
  ]);
  assert.equal(body, "- first bullet\n  - nested");
});

test("a property written as the first bullet is still a property", () => {
  const { props, body } = splitPageProps("- type:: reference\n- a bullet\n");
  assert.deepEqual(props, [["type", "reference"]]);
  assert.equal(body, "- a bullet");
});

test("a property line further down is body text, not frontmatter", () => {
  const { props, body } = splitPageProps("- a bullet\n- id:: 6512ab\n");
  assert.deepEqual(props, []);
  assert.equal(body, "- a bullet\n- id:: 6512ab");
});

test("a page with no properties keeps its whole body", () => {
  const { props, body } = splitPageProps("- just bullets\n- and more\n");
  assert.deepEqual(props, []);
  assert.equal(body, "- just bullets\n- and more");
});

test("a namespaced page name becomes folders, in both encodings", () => {
  assert.deepEqual(pageTarget("pages/Reeds.md"), {
    title: "Reeds",
    folder: LOGSEQ_PAGES_FOLDER,
  });
  assert.deepEqual(pageTarget("pages/Work%2FClients.md"), {
    title: "Clients",
    folder: `${LOGSEQ_PAGES_FOLDER}/Work`,
  });
  assert.deepEqual(pageTarget("pages/Gear___Pedals.md"), {
    title: "Pedals",
    folder: `${LOGSEQ_PAGES_FOLDER}/Gear`,
  });
});

test("a journal filename maps to its ISO day, or to nothing", () => {
  assert.equal(journalDay("journals/2026_02_01.md"), "2026-02-01");
  assert.equal(journalDay("journals/2026-02-01.md"), "2026-02-01");
  assert.equal(journalDay("journals/contents.md"), null);
  assert.equal(journalDay("journals/2026_13_01.md"), null);
});

test("body asset references resolve against the graph, unknown ones do not", () => {
  const assets = new Map([["tide.png", "assets/tide.png"]]);
  assert.deepEqual(bodyAssets("- ![tide](../assets/tide.png)\n- ![x](../assets/gone.png)", assets), [
    { sourcePath: "assets/tide.png", filename: "tide.png" },
  ]);
  // the same asset twice is one attachment
  assert.equal(bodyAssets("![a](assets/tide.png) ![b](../assets/tide.png)", assets).length, 1);
  // a nested reference resolves on its filename — the scan keys assets that way
  assert.deepEqual(bodyAssets("![t](../assets/2026/tide.png)", assets), [
    { sourcePath: "assets/tide.png", filename: "tide.png" },
  ]);
});

test("asset references are rewritten to the vault's embed form once landed", () => {
  const landed = new Map([["tide.png", "tide 2.png"]]);
  // both forms come out as `![[…]]`: a bare `[[name]]` is a link to a note of
  // that name, so keeping the source's missing bang would point a link at
  // nothing rather than at the file that just landed
  assert.equal(
    rewriteAssetRefs("- ![tide](../assets/tide.png) and [file](../assets/tide.png)", landed),
    "- ![[tide 2.png]] and ![[tide 2.png]]"
  );
  // a reference into an asset subfolder resolves on the filename, which is
  // what the scan keyed it under
  assert.equal(
    rewriteAssetRefs("![t](../assets/2026/tide.png)", landed),
    "![[tide 2.png]]"
  );
  // an asset that never landed keeps the reference it had
  assert.equal(
    rewriteAssetRefs("![x](../assets/gone.png)", landed),
    "![x](../assets/gone.png)"
  );
});

test("a whole graph parses into items, skips and caveats", () => {
  const scan = logseqClassify(SCAN);
  const texts = new Map([
    ["pages/Reeds.md", "tags:: field\n\n- a reed\n- ![tide](../assets/tide_1700000000000_0.png)"],
    ["pages/Work%2FClients.md", "- a client"],
    ["pages/Gear___Pedals.md", "- a pedal"],
    ["journals/2026_02_01.md", "- woke up"],
    ["journals/2026_02_02.md", "   "],
    ["journals/contents.md", "- a table of contents"],
  ]);
  const parse = logseqParse(scan, texts, "graph");

  const byId = new Map(parse.items.map((i) => [i.importId, i]));
  assert.deepEqual([...byId.keys()].sort(), [
    "graph/journals/2026_02_01.md",
    "graph/pages/Gear___Pedals.md",
    "graph/pages/Reeds.md",
    "graph/pages/Work%2FClients.md",
  ]);

  const reeds = byId.get("graph/pages/Reeds.md")!;
  assert.deepEqual(reeds.props, [["tags", "field"]]);
  assert.deepEqual(reeds.attachments, [
    {
      sourcePath: "assets/tide_1700000000000_0.png",
      filename: "tide_1700000000000_0.png",
    },
  ]);

  const journal = byId.get("graph/journals/2026_02_01.md")!;
  assert.equal(journal.folder, JOURNAL_FOLDER);
  assert.equal(journal.title, "2026-02-01");
  assert.equal(journal.created, "2026-02-01");

  const reasons = Object.fromEntries(skipSummary(parse.skips).map((s) => [s.reason, s.count]));
  assert.equal(reasons["org-mode file — this import reads markdown only"], 2);
  assert.equal(reasons["journal filename is not a date"], 1);
  assert.equal(reasons["empty page"], 1);
  assert.equal(reasons["asset no imported page embeds"], 1);

  assert.ok(parse.notes.some((n) => /bullets/i.test(n)));
});

test("a second run over the same graph creates nothing", () => {
  const scan = logseqClassify(SCAN);
  const texts = new Map([
    ["pages/Reeds.md", "- a reed"],
    ["pages/Work%2FClients.md", "- a client"],
    ["pages/Gear___Pedals.md", "- a pedal"],
    ["journals/2026_02_01.md", "- woke up"],
    ["journals/2026_02_02.md", "- and again"],
    ["journals/contents.md", "- a table of contents"],
  ]);
  const parse = logseqParse(scan, texts, "graph");
  const first = buildPlan("logseq", "~/graph", parse, new Set(), new Set());
  assert.equal(first.create.length, 5);

  // the vault now carries the stamps the first run wrote
  const vault = first.create.map((i) => ({
    props: { "import-source": "logseq", "import-id": i.importId } as Record<string, unknown>,
  }));
  const second = buildPlan("logseq", "~/graph", parse, existingStamps(vault), new Set());
  assert.equal(second.create.length, 0);
  assert.equal(second.alreadyImported.length, 5);

  // a different graph holding the same relative paths is a different import,
  // not a re-run of this one
  const other = logseqParse(scan, texts, "second-graph");
  const third = buildPlan("logseq", "~/second-graph", other, existingStamps(vault), new Set());
  assert.equal(third.create.length, 5);
  assert.equal(third.alreadyImported.length, 0);
});

test("properties the vault owns are kept under a prefixed name, not dropped", () => {
  const scan = logseqClassify([{ path: "pages/Reeds.md", size: 40 }]);
  const parse = logseqParse(
    scan,
    new Map([
      ["pages/Reeds.md", "title:: Reed notes\nType:: reference\ncreated:: 2019-04-02\nmood:: low\n\n- a reed"],
    ]),
    "graph"
  );
  assert.deepEqual(parse.items[0].props, [
    ["logseq-title", "Reed notes"],
    ["logseq-type", "reference"],
    ["logseq-created", "2019-04-02"],
    ["mood", "low"],
  ]);
  assert.ok(parse.notes.some((n) => /logseq-title/.test(n)));
});

test("a key written twice keeps one entry, so the create is never refused", () => {
  // the vault's create refuses props whose keys differ only in case; last value
  // wins, in the position and spelling the page first used
  const { props } = splitPageProps("Alias:: one\nalias:: two\ntags:: field\n\n- body");
  assert.deepEqual(props, [
    ["Alias", "two"],
    ["tags", "field"],
  ]);
});

test("a page past the size cap is a counted skip, not a read", () => {
  const scan = logseqClassify([
    { path: "pages/Huge.md", size: 2 * 1024 * 1024 + 1 },
    { path: "journals/2026_02_01.md", size: 3 * 1024 * 1024 },
    { path: "pages/Reeds.md", size: 2 * 1024 * 1024 },
  ]);
  assert.deepEqual(scan.pages, ["pages/Reeds.md"]);
  assert.deepEqual(scan.journals, []);
  assert.deepEqual(skipSummary(scan.skips), [
    { reason: "larger than the 2 MiB page cap", count: 2 },
  ]);
});
