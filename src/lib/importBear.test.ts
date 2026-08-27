import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEAR_FOLDER,
  BEAR_SOURCE,
  bearClassify,
  bearDates,
  bearParse,
  bearRewriteAssets,
  extractTags,
  splitTitle,
  tagFolder,
} from "./importBear.ts";
import { buildPlan, existingStamps, skipSummary } from "./importer.ts";
import type { ScanEntry } from "./importLogseq.ts";

const SCAN: ScanEntry[] = [
  { path: "Reeds.md", size: 120 },
  { path: "Tide table.markdown", size: 80 },
  { path: "Ferry.textbundle/text.md", size: 90 },
  { path: "Ferry.textbundle/info.json", size: 200 },
  { path: "Ferry.textbundle/assets/harbour.png", size: 4096 },
  { path: "Ferry.textbundle/assets/spare.png", size: 512 },
  { path: "Ferry.textbundle/notes.rtf", size: 40 },
  { path: "Empty.textbundle/info.json", size: 30 },
  { path: "Backup 2026-02-01.bear2bk", size: 900_000 },
  { path: "Packed.textpack", size: 5_000 },
  { path: "Readme.rtf", size: 15 },
  { path: ".DS_Store", size: 6148 },
];

function textsFor(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

test("the scan sorts an export into notes, bundle files and reasons", () => {
  const scan = bearClassify(SCAN);
  assert.deepEqual(
    scan.notes.map((note) => note.path),
    ["Ferry.textbundle/text.md", "Reeds.md", "Tide table.markdown"]
  );
  const ferry = scan.notes.find((note) => note.path.startsWith("Ferry"))!;
  assert.equal(ferry.stem, "Ferry");
  assert.equal(ferry.info, "Ferry.textbundle/info.json");
  assert.equal(ferry.assets.get("harbour.png"), "Ferry.textbundle/assets/harbour.png");
  // the reads are the note texts plus the info files beside them, nothing else
  assert.deepEqual(scan.reads, [
    "Ferry.textbundle/text.md",
    "Ferry.textbundle/info.json",
    "Reeds.md",
    "Tide table.markdown",
  ]);
  // the editor's leftovers raise no skip line
  assert.ok(!scan.skips.some((skip) => skip.path === ".DS_Store"));
  assert.deepEqual(skipSummary(scan.skips), [
    { reason: "Bear backup archive — unzip it and pick the folder inside", count: 1 },
    { reason: "inside a text bundle, but not its text, assets or info", count: 1 },
    { reason: "not a note, a text bundle or a file one of them uses", count: 1 },
    { reason: "text bundle with no text file", count: 1 },
    { reason: "zipped text bundle — unzip it and pick the folder inside", count: 1 },
  ]);
});

test("a backup archive and a text pack are counted skips that say to unzip them", () => {
  const scan = bearClassify([
    { path: "Backup 2026-02-01.bear2bk", size: 900_000 },
    { path: "Packed.textpack", size: 5_000 },
  ]);
  assert.deepEqual(scan.notes, []);
  assert.deepEqual(
    scan.skips.map((skip) => skip.reason),
    [
      "Bear backup archive — unzip it and pick the folder inside",
      "zipped text bundle — unzip it and pick the folder inside",
    ]
  );
});

test("a note past the size cap is a counted skip, not a read", () => {
  const scan = bearClassify([
    { path: "Huge.md", size: 2 * 1024 * 1024 + 1 },
    { path: "Long.textbundle/text.md", size: 3 * 1024 * 1024 },
    { path: "Reeds.md", size: 2 * 1024 * 1024 },
  ]);
  assert.deepEqual(
    scan.notes.map((note) => note.path),
    ["Reeds.md"]
  );
  // the oversized bundle says its size once — not that, and also "no text file"
  assert.deepEqual(skipSummary(scan.skips), [
    { reason: "larger than the 2 MiB note cap", count: 2 },
  ]);
});

test("the title is the leading heading, and the heading is not written twice", () => {
  assert.deepEqual(splitTitle("# Reed notes\n\nCut at dawn.", "Reeds"), {
    title: "Reed notes",
    body: "Cut at dawn.",
    tags: [],
  });
  // a heading further down is a heading and stays in the body
  assert.deepEqual(splitTitle("Cut at dawn.\n\n# Later", "Reeds"), {
    title: "Reeds",
    body: "Cut at dawn.\n\n# Later",
    tags: [],
  });
  assert.deepEqual(splitTitle("", "Reeds"), { title: "Reeds", body: "", tags: [] });
  assert.deepEqual(splitTitle("", ""), { title: "Untitled", body: "", tags: [] });
});

test("a tag on the title line files the note instead of ending up in its name", () => {
  const scan = bearClassify([{ path: "Reeds.md", size: 40 }]);
  const parse = bearParse(
    scan,
    textsFor([["Reeds.md", "# Reeds #field/recording\n\nCut at dawn."]]),
    "Export"
  );
  assert.equal(parse.items.length, 1);
  assert.equal(parse.items[0].title, "Reeds");
  assert.equal(parse.items[0].folder, `${BEAR_FOLDER}/field/recording`);
  assert.equal(parse.items[0].body, "Cut at dawn.");
});

test("a title-line tag files ahead of the body's tags", () => {
  const scan = bearClassify([{ path: "Reeds.md", size: 40 }]);
  const parse = bearParse(
    scan,
    textsFor([["Reeds.md", "# Reeds #field\n\nCut at dawn. #tide"]]),
    "Export"
  );
  assert.equal(parse.items[0].folder, `${BEAR_FOLDER}/field`);
  assert.deepEqual(parse.items[0].props, [["tags", "tide"]]);
});

test("a note that is a title and a tag is imported, not called empty", () => {
  const scan = bearClassify([{ path: "Boatyard.md", size: 40 }]);
  const parse = bearParse(
    scan,
    textsFor([["Boatyard.md", "# Call the boatyard\n\n#todo"]]),
    "Export"
  );
  assert.deepEqual(parse.skips, []);
  assert.equal(parse.items.length, 1);
  assert.equal(parse.items[0].title, "Call the boatyard");
  assert.equal(parse.items[0].folder, `${BEAR_FOLDER}/todo`);
  assert.equal(parse.items[0].body, "");
});

test("tags come out of the body, and a line that was only tags goes with them", () => {
  const { tags, body } = extractTags("Cut at dawn near the #harbour.\n\n#field/reeds #tide");
  assert.deepEqual(tags, ["harbour", "field/reeds", "tide"]);
  assert.equal(body, "Cut at dawn near the .");
});

test("a second # tight against a word closes the tag it opened", () => {
  // the closed form Bear reads that line as: one tag, and no prose left over
  const { tags, body } = extractTags("#reeds and a C#");
  assert.deepEqual(tags, ["reeds and a C"]);
  assert.equal(body, "");
});

test("removing a tag leaves the rest of the line's spacing alone", () => {
  const { tags, body } = extractTags("Column A    Column B #field");
  assert.deepEqual(tags, ["field"]);
  assert.equal(body, "Column A    Column B");
  // and the space the token sat between is merged, not left doubled
  assert.equal(extractTags("Cut at dawn #field near the reeds.").body, "Cut at dawn near the reeds.");
});

test("a tag after punctuation is a tag", () => {
  const { tags, body } = extractTags("Bring the recorder (#gear) tomorrow.");
  assert.deepEqual(tags, ["gear"]);
  assert.equal(body, "Bring the recorder () tomorrow.");
});

test("an unpaired backtick does not hide the tags after it", () => {
  const { tags } = extractTags("Recorded at 6am ` #field/reeds");
  assert.deepEqual(tags, ["field/reeds"]);
});

test("a closed multi-word tag is one tag", () => {
  const { tags, body } = extractTags("Filed under #low water mark#\n\nRest of it.");
  assert.deepEqual(tags, ["low water mark"]);
  assert.equal(body, "Filed under\n\nRest of it.");
});

test("headings, numbers and code are not tags", () => {
  const { tags, body } = extractTags(
    "# Notes\n## Later\nTake #2 of the take.\nA colour `#ff00aa` here.\n```\n#fenced\n```\nEnd near#thing."
  );
  assert.deepEqual(tags, []);
  assert.equal(
    body,
    "# Notes\n## Later\nTake #2 of the take.\nA colour `#ff00aa` here.\n```\n#fenced\n```\nEnd near#thing."
  );
});

test("a repeated tag is one tag, in the spelling it was first written", () => {
  const { tags } = extractTags("#Tide and again #tide and #tide/low");
  assert.deepEqual(tags, ["Tide", "tide/low"]);
});

test("the first tag is the folder, nested tags included; no tag lands at the root", () => {
  assert.equal(tagFolder("field/reeds"), `${BEAR_FOLDER}/field/reeds`);
  assert.equal(tagFolder("low water mark"), `${BEAR_FOLDER}/low water mark`);
  assert.equal(tagFolder(undefined), BEAR_FOLDER);
  // a tag that survives sanitizing as nothing names no folder
  assert.equal(tagFolder("///"), BEAR_FOLDER);
});

test("info.json dates are used when present and parseable, and never guessed", () => {
  assert.deepEqual(
    bearDates('{"net.shinyfrog.bear":{"creationDate":"2019-04-02T09:15:00Z","modificationDate":"2020-01-08T11:00:00Z"}}'),
    { created: "2019-04-02", modified: "2020-01-08" }
  );
  assert.deepEqual(bearDates(undefined), {});
  assert.deepEqual(bearDates("{ not json"), {});
  assert.deepEqual(bearDates('{"org.textbundle":{"creationDate":"2019-04-02"}}'), {});
  assert.deepEqual(bearDates('{"net.shinyfrog.bear":{"creationDate":"last tuesday"}}'), {
    created: undefined,
    modified: undefined,
  });
});

test("a plain markdown export parses into a note filed under its first tag", () => {
  const scan = bearClassify([{ path: "Reeds.md", size: 120 }]);
  const parse = bearParse(
    scan,
    textsFor([["Reeds.md", "# Reed notes\n\nCut at dawn. #field/reeds #tide #Tide"]]),
    "Export"
  );
  assert.equal(parse.items.length, 1);
  const item = parse.items[0];
  assert.equal(item.importId, "Export/Reeds.md");
  assert.equal(item.title, "Reed notes");
  assert.equal(item.folder, `${BEAR_FOLDER}/field/reeds`);
  assert.equal(item.body, "Cut at dawn.");
  // the tags past the first are what the note is about, not where it lives
  assert.deepEqual(item.props, [["tags", "tide"]]);
  assert.equal(item.created, undefined);
  assert.deepEqual(item.attachments, []);
});

test("a note with no tags lands at the import root", () => {
  const scan = bearClassify([{ path: "Ferry.md", size: 40 }]);
  const parse = bearParse(scan, textsFor([["Ferry.md", "# Ferry\n\nNo filing at all."]]), "Export");
  assert.equal(parse.items[0].folder, BEAR_FOLDER);
  assert.deepEqual(parse.items[0].props, []);
});

test("a text bundle carries its assets, its dates and a rewritten reference", () => {
  const scan = bearClassify([
    { path: "Ferry.textbundle/text.md", size: 90 },
    { path: "Ferry.textbundle/info.json", size: 200 },
    { path: "Ferry.textbundle/assets/harbour.png", size: 4096 },
    { path: "Ferry.textbundle/assets/spare.png", size: 512 },
  ]);
  const parse = bearParse(
    scan,
    textsFor([
      [
        "Ferry.textbundle/text.md",
        "# Ferry\n\nThe harbour at dusk.\n\n![](assets/harbour.png)\n\n#travel",
      ],
      [
        "Ferry.textbundle/info.json",
        '{"version":2,"net.shinyfrog.bear":{"creationDate":"2019-04-02T09:15:00Z","modificationDate":"2020-01-08T11:00:00Z"}}',
      ],
    ]),
    "Export"
  );
  const item = parse.items[0];
  assert.equal(item.importId, "Export/Ferry.textbundle/text.md");
  assert.equal(item.title, "Ferry");
  assert.equal(item.folder, `${BEAR_FOLDER}/travel`);
  assert.equal(item.created, "2019-04-02");
  assert.deepEqual(item.props, [["bear-modified", "2020-01-08"]]);
  assert.deepEqual(item.attachments, [
    { sourcePath: "Ferry.textbundle/assets/harbour.png", filename: "harbour.png" },
  ]);
  // the asset nothing embeds is counted, not copied
  assert.ok(
    parse.skips.some(
      (skip) =>
        skip.path === "Ferry.textbundle/assets/spare.png" &&
        skip.reason === "asset no imported note embeds"
    )
  );
  const landed = new Map([["harbour.png", "harbour 2.png"]]);
  assert.equal(
    bearRewriteAssets(item.body, landed),
    "The harbour at dusk.\n\n![[harbour 2.png]]"
  );
});

test("a note that could not be read, and one with nothing in it, are counted skips", () => {
  const scan = bearClassify([
    { path: "Gone.md", size: 40 },
    { path: "Blank.md", size: 4 },
  ]);
  const parse = bearParse(scan, textsFor([["Blank.md", "# Blank\n\n   \n"]]), "Export");
  assert.deepEqual(parse.items, []);
  assert.deepEqual(skipSummary(parse.skips), [
    { reason: "couldn't be read", count: 1 },
    { reason: "empty note", count: 1 },
  ]);
});

test("two exports holding the same note name are not one another's re-runs", () => {
  const scan = bearClassify([{ path: "Reeds.md", size: 40 }]);
  const texts = textsFor([["Reeds.md", "# Reeds\n\nCut at dawn."]]);
  const first = bearParse(scan, texts, "Export one");
  const second = bearParse(scan, texts, "Export two");
  assert.notEqual(first.items[0].importId, second.items[0].importId);
});

test("notes sharing a title land side by side, and the plan says so first", () => {
  const scan = bearClassify([
    { path: "Reeds.md", size: 40 },
    { path: "Reeds 1.md", size: 40 },
  ]);
  const parse = bearParse(
    scan,
    textsFor([
      ["Reeds.md", "# Reeds\n\nOne. #field"],
      ["Reeds 1.md", "# Reeds\n\nAnother. #field"],
    ]),
    "Export"
  );
  const plan = buildPlan(BEAR_SOURCE, "~/Export", parse, new Set(), new Set());
  assert.deepEqual(plan.titleCollisions, [
    { title: "Reeds", folder: `${BEAR_FOLDER}/field`, count: 2 },
  ]);
});

test("a second run of the same export writes nothing", () => {
  const scan = bearClassify([{ path: "Reeds.md", size: 40 }]);
  const parse = bearParse(scan, textsFor([["Reeds.md", "# Reeds\n\nCut at dawn."]]), "Export");
  const already = existingStamps([
    { props: { "import-source": BEAR_SOURCE, "import-id": "Export/Reeds.md" } },
  ]);
  const plan = buildPlan(BEAR_SOURCE, "~/Export", parse, already, new Set());
  assert.deepEqual(plan.create, []);
  assert.equal(plan.alreadyImported.length, 1);
});

test("two assets in one bundle sharing a name are counted, not overwritten", () => {
  const scan = bearClassify([
    { path: "Ferry.textbundle/text.md", size: 40 },
    { path: "Ferry.textbundle/assets/harbour.png", size: 40 },
    { path: "Ferry.textbundle/assets/old/harbour.png", size: 40 },
  ]);
  assert.deepEqual(scan.skips, [
    { path: "Ferry.textbundle/assets/old/harbour.png", reason: "same name as another asset in this bundle" },
  ]);
  const note = scan.notes[0];
  assert.equal(note.assets.get("harbour.png"), "Ferry.textbundle/assets/harbour.png");
});

test("an info file that would not read is counted, and the note still imports", () => {
  const scan = bearClassify([
    { path: "Ferry.textbundle/text.md", size: 40 },
    { path: "Ferry.textbundle/info.json", size: 40 },
  ]);
  // the info path is left out of `texts`, the way a failed read leaves it
  const parse = bearParse(
    scan,
    textsFor([["Ferry.textbundle/text.md", "# Ferry\n\nLeaves at six."]]),
    "Export"
  );
  assert.equal(parse.items.length, 1);
  assert.equal(parse.items[0].created, undefined);
  assert.deepEqual(parse.skips, [
    {
      path: "Ferry.textbundle/info.json",
      reason: "couldn't be read — created date not set",
    },
  ]);
});

test("the preview's caveats say what the import does not carry over", () => {
  const parse = bearParse(bearClassify([]), new Map(), "Export");
  assert.ok(parse.notes.some((note) => /first tag/.test(note)));
  assert.ok(parse.notes.some((note) => /\.bear2bk/.test(note)));
});
