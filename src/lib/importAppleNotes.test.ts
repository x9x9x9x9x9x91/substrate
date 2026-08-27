import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPLE_NOTES_FOLDER,
  SAMPLE_LIMIT,
  appleNotesClassify,
  appleNotesParse,
  decodeEntities,
  encodeImageRef,
  htmlToMarkdown,
  noteFolder,
  resolveImageRef,
  rewriteAppleAssetRefs,
} from "./importAppleNotes.ts";
import { buildPlan, existingStamps, skipSummary, type ScanEntry } from "./importer.ts";

/** An export shaped the way the third-party exporters write one: one HTML file
    per note, folders for the user's own folders, images in a sidecar dir. */
const SCAN: ScanEntry[] = [
  { path: "Tide chart.html", size: 900 },
  { path: "Tide chart_files/mudflat.png", size: 4096 },
  { path: "Kit list.txt", size: 120 },
  { path: "Already markdown.md", size: 80 },
  { path: "Errands/Groceries.html", size: 300 },
  { path: "Errands/Deep/Nested plan.htm", size: 220 },
  { path: "leftovers.bin", size: 64 },
  { path: ".DS_Store", size: 6 },
  { path: "Tide chart_files/.hidden", size: 2 },
];

function classify(files: ScanEntry[] = SCAN) {
  return appleNotesClassify(files);
}

/* ---------------------------------------------------------------- */
/* The converter                                                     */
/* ---------------------------------------------------------------- */

test("divs and breaks become paragraphs and lines, not one run-on block", () => {
  const { markdown } = htmlToMarkdown(
    "<html><body><div>First line<br>second line</div><div>A new paragraph.</div></body></html>"
  );
  assert.equal(markdown, "First line\nsecond line\n\nA new paragraph.");
});

test("bold and italic survive, and an empty pair does not swallow its neighbours", () => {
  const { markdown } = htmlToMarkdown(
    "<div>a <b>bold</b> and <i>slanted</i> and <em>also</em> and <strong>heavy</strong></div>" +
      "<div>spaced <b> </b>out</div>"
  );
  assert.equal(
    markdown,
    "a **bold** and *slanted* and *also* and **heavy**\n\nspaced out"
  );
});

test("headings h1 to h3 map to their markdown depth", () => {
  const { markdown, title } = htmlToMarkdown(
    "<h1>Tide chart</h1><div>intro</div><h2>Morning</h2><h3>Detail</h3><div>text</div>"
  );
  assert.equal(markdown, "# Tide chart\n\nintro\n\n## Morning\n\n### Detail\n\ntext");
  // with no <title>, the first heading is the title
  assert.equal(title, "Tide chart");
});

test("a document title beats the first heading, and both beat nothing", () => {
  const withTitle = htmlToMarkdown("<title>Declared</title><h1>Heading</h1>");
  assert.equal(withTitle.title, "Declared");
  assert.equal(htmlToMarkdown("<div>just text</div>").title, "");
});

test("nested lists indent, and ordered lists number", () => {
  const { markdown } = htmlToMarkdown(
    "<ul><li>outer one<ul><li>inner one</li><li>inner two</li></ul></li><li>outer two</li></ul>" +
      "<ol><li>first</li><li>second</li></ol>"
  );
  assert.equal(
    markdown,
    [
      "- outer one",
      "  - inner one",
      "  - inner two",
      "- outer two",
      "",
      "1. first",
      "2. second",
    ].join("\n")
  );
});

test("an unclosed list item does not nest the rest of the list inside it", () => {
  const { markdown } = htmlToMarkdown("<ul><li>one<li>two<li>three</ul>");
  assert.equal(markdown, "- one\n- two\n- three");
});

test("checklists map to markdown task items, ticked and not", () => {
  const byClass = htmlToMarkdown(
    '<ul class="checklist"><li class="checked">packed</li><li class="unchecked">still to do</li></ul>'
  );
  assert.equal(byClass.markdown, "- [x] packed\n- [ ] still to do");

  const byInput = htmlToMarkdown(
    '<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">not done</li></ul>'
  );
  assert.equal(byInput.markdown, "- [x] done\n- [ ] not done");

  // a checklist class on the list alone still means boxes, unticked
  const byList = htmlToMarkdown('<ul class="checklist"><li>a box</li></ul>');
  assert.equal(byList.markdown, "- [ ] a box");
});

test("a list item that wraps its text in a block keeps its bullet", () => {
  const { markdown } = htmlToMarkdown(
    "<ul><li><div>one</div></li><li><div>two</div></li></ul>"
  );
  assert.equal(markdown, "- one\n- two");
});

test("a checklist whose items wrap their text in divs keeps its ticks", () => {
  const { markdown } = htmlToMarkdown(
    '<ul class="checklist">' +
      '<li class="checked"><div>packed</div></li>' +
      '<li class="unchecked"><div>still to pack</div></li>' +
      "</ul>"
  );
  assert.equal(markdown, "- [x] packed\n- [ ] still to pack");
});

test("an unchecked class is never read as a checked one", () => {
  const { markdown } = htmlToMarkdown('<ul><li class="item-unchecked">open</li></ul>');
  assert.equal(markdown, "- [ ] open");
});

test("links keep their text and their target", () => {
  const { markdown } = htmlToMarkdown(
    '<div>see <a href="https://example.invalid/page">the page</a></div>' +
      '<div><a href="https://example.invalid/bare"></a></div>'
  );
  assert.equal(
    markdown,
    "see [the page](https://example.invalid/page)\n\n<https://example.invalid/bare>"
  );
});

test("entities decode, named and numeric alike", () => {
  const { markdown } = htmlToMarkdown(
    "<div>Reeds &amp; tape &mdash; &quot;quoted&quot; &#39;and&#39; &#x2713; &nbsp;spaced &unknownthing;</div>"
  );
  assert.equal(markdown, "Reeds & tape — \"quoted\" 'and' ✓ spaced &unknownthing;");
});

test("decodeEntities leaves a malformed reference exactly as written", () => {
  assert.equal(decodeEntities("100% &amp; rising &#999999999; &"), "100% & rising &#999999999; &");
});

test("a tag the converter does not know keeps its words", () => {
  const { markdown } = htmlToMarkdown(
    '<div><span style="color:red">coloured</span> and <marquee>invented</marquee> and ' +
      "<u>underlined</u></div>"
  );
  assert.equal(markdown, "coloured and invented and underlined");
});

test("blockquotes, rules and preformatted blocks come across", () => {
  const { markdown } = htmlToMarkdown(
    "<blockquote>quoted line</blockquote><hr><pre>  kept   spacing\n  second</pre>"
  );
  assert.equal(
    markdown,
    ["> quoted line", "", "---", "", "```", "  kept   spacing", "  second", "```"].join("\n")
  );
});

test("table rows come across as their cells, one row per line", () => {
  const { markdown } = htmlToMarkdown(
    "<table><tr><th>Item</th><th>Count</th></tr><tr><td>reeds</td><td>4</td></tr></table>"
  );
  assert.equal(markdown, "Item | Count\nreeds | 4");
});

test("a cell wrapping its text in a block still shares its row's line", () => {
  const { markdown } = htmlToMarkdown(
    "<table><tr><td><p>A</p></td><td><p>B</p></td></tr>" +
      "<tr><td><div>C</div></td><td><div>D</div></td></tr></table>"
  );
  assert.equal(markdown, "A | B\nC | D");
});

/* ---------------------------------------------------------------- */
/* Images and attachments                                            */
/* ---------------------------------------------------------------- */

test("an img pointing at a shipped file becomes an attachment with a rewritable ref", () => {
  const scan = classify();
  const converted = htmlToMarkdown(
    '<div>before<img src="Tide%20chart_files/mudflat.png" alt="the mudflat">after</div>',
    (src) => {
      const hit = resolveImageRef("Tide chart.html", src, scan.candidates);
      return hit ? { sourcePath: hit, ref: encodeImageRef(hit) } : null;
    }
  );
  assert.deepEqual(converted.images, [
    { sourcePath: "Tide chart_files/mudflat.png", ref: "Tide%20chart_files/mudflat.png" },
  ]);
  assert.equal(
    converted.markdown,
    "before![the mudflat](Tide%20chart_files/mudflat.png)after"
  );

  const landed = new Map([["tide chart_files/mudflat.png", "mudflat.png"]]);
  assert.equal(
    rewriteAppleAssetRefs(converted.markdown, landed),
    "before![[mudflat.png]]after"
  );
});

test("an img the export did not ship keeps its reference rather than vanishing", () => {
  const { markdown, images } = htmlToMarkdown('<div><img src="missing.png" alt="gone"></div>');
  assert.equal(markdown, "![gone](missing.png)");
  assert.deepEqual(images, []);
});

test("a bracket in an img's alt text does not break the reference to it", () => {
  const converted = htmlToMarkdown('<div><img src="cover.png" alt="a] b"></div>', (src) =>
    src === "cover.png" ? { sourcePath: "cover.png", ref: "cover.png" } : null
  );
  assert.equal(converted.markdown, "![a\\] b](cover.png)");
  // and the copied file is still reachable once it has landed
  assert.equal(
    rewriteAppleAssetRefs(converted.markdown, new Map([["cover.png", "cover.png"]])),
    "![[cover.png]]"
  );
});

test("a reference climbing out of the picked folder resolves to nothing", () => {
  const candidates = new Map([["shared/other.png", "shared/other.png"]]);
  // a note at the root has nothing above it to climb to
  assert.equal(resolveImageRef("Groceries.html", "../shared/other.png", candidates), null);
  assert.equal(
    resolveImageRef("Errands/Deep/Nested plan.htm", "../../../shared/other.png", candidates),
    null
  );
  // climbing only as far as the root still resolves
  assert.equal(
    resolveImageRef("Errands/Deep/Nested plan.htm", "../../shared/other.png", candidates),
    "shared/other.png"
  );
  // an absolute URL names something outside this folder by definition
  assert.equal(resolveImageRef("a.html", "https://example.invalid/x.png", candidates), null);
});

test("the rewrite leaves every link that is not an attachment this run copied", () => {
  const body = "see [the page](https://example.invalid/p) and ![shot](img/one.png)";
  const landed = new Map([["img/one.png", "one.png"]]);
  assert.equal(
    rewriteAppleAssetRefs(body, landed),
    "see [the page](https://example.invalid/p) and ![[one.png]]"
  );
});

/* ---------------------------------------------------------------- */
/* The folder                                                        */
/* ---------------------------------------------------------------- */

test("the scan sorts an export into notes, attachment candidates and skips", () => {
  const scan = classify();
  assert.deepEqual(scan.notes, [
    "Already markdown.md",
    "Errands/Deep/Nested plan.htm",
    "Errands/Groceries.html",
    "Kit list.txt",
    "Tide chart.html",
  ]);
  assert.equal(scan.candidates.get("leftovers.bin"), "leftovers.bin");
  assert.equal(scan.candidates.get("tide chart_files/mudflat.png"), "Tide chart_files/mudflat.png");
  // dotfiles are not content and raise no skip line
  assert.ok(!scan.candidates.has(".ds_store"));
  assert.ok(!scan.candidates.has("tide chart_files/.hidden"));
  assert.deepEqual(scan.skips, []);
});

test("a note past the size cap is a counted skip, not a read", () => {
  const scan = classify([
    { path: "Huge.html", size: 2 * 1024 * 1024 + 1 },
    { path: "Fine.html", size: 2 * 1024 * 1024 },
  ]);
  assert.deepEqual(scan.notes, ["Fine.html"]);
  assert.deepEqual(skipSummary(scan.skips), [
    { reason: "larger than the 2 MiB note cap", count: 1 },
  ]);
});

test("subfolders in the export become folders under the import root", () => {
  assert.equal(noteFolder("Tide chart.html"), APPLE_NOTES_FOLDER);
  assert.equal(noteFolder("Errands/Groceries.html"), `${APPLE_NOTES_FOLDER}/Errands`);
  assert.equal(
    noteFolder("Errands/Deep/Nested plan.htm"),
    `${APPLE_NOTES_FOLDER}/Errands/Deep`
  );
});

const TEXTS = new Map<string, string>([
  [
    "Tide chart.html",
    "<html><head><title>Tide chart</title></head><body>" +
      "<div>Readings for the <b>mudflat</b>.</div>" +
      '<div><img src="Tide%20chart_files/mudflat.png" alt="the flat"></div>' +
      "<ul><li>morning</li><li>evening</li></ul></body></html>",
  ],
  ["Kit list.txt", "one line\r\nsecond line\r\n\r\n\r\nlater paragraph\r\n"],
  ["Already markdown.md", "# Kept as written\n\n- a bullet\n"],
  ["Errands/Groceries.html", "<div>reeds</div>"],
  ["Errands/Deep/Nested plan.htm", "<h1>Nested plan</h1><div>a step</div>"],
]);

test("the parse turns an export into items, with folders, titles and attachments", () => {
  const scan = classify();
  const parse = appleNotesParse(scan, TEXTS, "Notes export");
  const byId = new Map(parse.items.map((item) => [item.importId, item]));

  const tide = byId.get("Notes export/Tide chart.html");
  assert.ok(tide);
  assert.equal(tide.title, "Tide chart");
  assert.equal(tide.folder, APPLE_NOTES_FOLDER);
  assert.match(tide.body, /Readings for the \*\*mudflat\*\*\./);
  assert.match(tide.body, /- morning\n- evening/);
  assert.deepEqual(tide.attachments, [
    {
      sourcePath: "Tide chart_files/mudflat.png",
      filename: "Tide chart_files/mudflat.png",
    },
  ]);

  // .txt wraps as paragraphs, .md passes through, both titled by their stem
  assert.equal(byId.get("Notes export/Kit list.txt")?.body, "one line\nsecond line\n\nlater paragraph");
  assert.equal(byId.get("Notes export/Kit list.txt")?.title, "Kit list");
  assert.equal(byId.get("Notes export/Already markdown.md")?.body, "# Kept as written\n\n- a bullet");
  assert.equal(byId.get("Notes export/Already markdown.md")?.title, "Kept as written");

  // a file in a subfolder lands under that folder, titled by its own heading
  const nested = byId.get("Notes export/Errands/Deep/Nested plan.htm");
  assert.equal(nested?.folder, `${APPLE_NOTES_FOLDER}/Errands/Deep`);
  assert.equal(nested?.title, "Nested plan");

  // the only shipped attachment is embedded, so nothing but the stray binary
  // is left over
  assert.deepEqual(skipSummary(parse.skips), [
    { reason: "not a note, and no imported note embeds it", count: 1 },
  ]);
  assert.ok(parse.notes.some((n) => /converted from the export's HTML/.test(n)));
});

test("a note that could not be read is a skip, never an empty note", () => {
  const scan = classify([
    { path: "Readable.html", size: 40 },
    { path: "Locked.html", size: 40 },
    { path: "Blank.html", size: 20 },
  ]);
  const parse = appleNotesParse(
    scan,
    new Map([
      ["Readable.html", "<div>words</div>"],
      ["Blank.html", "<div>   </div>"],
    ]),
    "export"
  );
  assert.deepEqual(
    parse.items.map((item) => item.importId),
    ["export/Readable.html"]
  );
  assert.deepEqual(skipSummary(parse.skips), [
    { reason: "couldn't be read", count: 1 },
    { reason: "empty note", count: 1 },
  ]);
});

test("two notes of the same title land side by side and the plan says so", () => {
  const scan = classify([
    { path: "One.html", size: 40 },
    { path: "Two.html", size: 40 },
  ]);
  const parse = appleNotesParse(
    scan,
    new Map([
      ["One.html", "<title>Errands</title><div>a</div>"],
      ["Two.html", "<title>Errands</title><div>b</div>"],
    ]),
    "export"
  );
  assert.deepEqual(
    parse.items.map((item) => item.title),
    ["Errands", "Errands"]
  );
  const plan = buildPlan("apple-notes", "~/export", parse, new Set(), new Set());
  assert.deepEqual(plan.titleCollisions, [
    { title: "Errands", folder: APPLE_NOTES_FOLDER, count: 2 },
  ]);
  // and the ids stay distinct, so a re-run recognizes both
  assert.equal(plan.create.length, 2);
});

test("a re-run recognizes what it already wrote", () => {
  const scan = classify([{ path: "One.html", size: 40 }]);
  const parse = appleNotesParse(scan, new Map([["One.html", "<div>a</div>"]]), "export");
  const stamped = existingStamps([
    { props: { "import-source": "apple-notes", "import-id": "export/One.html" } },
  ]);
  const plan = buildPlan("apple-notes", "~/export", parse, stamped, new Set());
  assert.equal(plan.create.length, 0);
  assert.equal(plan.alreadyImported.length, 1);
});

/* ---------------------------------------------------------------- */
/* The sample                                                        */
/* ---------------------------------------------------------------- */

test("the sample is a converted note, not the passthrough one that sorts first", () => {
  const scan = classify();
  const parse = appleNotesParse(scan, TEXTS, "Notes export");
  assert.ok(parse.sample);
  // `Already markdown.md` sorts first and would be a passthrough; the sample
  // exists to show the lossy conversion, so the first converted note wins
  assert.equal(parse.sample.title, "Nested plan");
  assert.equal(parse.sample.markdown, "# Nested plan\n\na step");
  // and it reaches the plan, which is what the pane reads
  const plan = buildPlan("apple-notes", "~/export", parse, new Set(), new Set());
  assert.deepEqual(plan.sample, parse.sample);
});

test("an export of nothing but passthrough notes still offers a sample", () => {
  const scan = classify([{ path: "Already markdown.md", size: 80 }]);
  const parse = appleNotesParse(scan, new Map([["Already markdown.md", "# Kept as written\n"]]), "export");
  assert.equal(parse.sample?.title, "Kept as written");
});

test("a single-line note is cut at a word boundary, inside the sample limit", () => {
  const line = "reeds ".repeat(700).trim();
  assert.ok(line.length > 4000);
  const scan = classify([{ path: "Long line.txt", size: 4200 }]);
  const parse = appleNotesParse(scan, new Map([["Long line.txt", line]]), "export");
  assert.ok(parse.sample);
  const shown = parse.sample.markdown;
  assert.ok(shown.length <= SAMPLE_LIMIT, `sample is ${shown.length} chars`);
  assert.ok(shown.endsWith("\n\n…"), "a cut sample says it was cut");
  // the last word is a whole word, not a piece of one
  assert.ok(/reeds\n\n…$/.test(shown), JSON.stringify(shown.slice(-16)));
});

test("a long note is truncated for the preview rather than shown whole", () => {
  const long = Array.from({ length: 400 }, (_, i) => `<div>line ${i}</div>`).join("");
  const scan = classify([{ path: "Long.html", size: 9000 }]);
  const parse = appleNotesParse(scan, new Map([["Long.html", long]]), "export");
  assert.ok(parse.sample);
  assert.ok(parse.items[0].body.length > SAMPLE_LIMIT, "the note itself is longer than the cut");
  assert.ok(parse.sample.markdown.length <= SAMPLE_LIMIT + 4);
  assert.ok(parse.sample.markdown.endsWith("…"), "a cut sample says it was cut");
  assert.ok(parse.sample.markdown.startsWith("line 0"));
});

test("a passthrough note's own image links are called out as kept-as-written", () => {
  const scan = classify([{ path: "Kit list.txt", size: 120 }]);
  const parse = appleNotesParse(scan, new Map([["Kit list.txt", "one line"]]), "export");
  assert.ok(
    parse.notes.some((note) => /\.md or \.txt/.test(note) && /not copied in/.test(note)),
    parse.notes.join(" | ")
  );
});

test("a file whose path differs from another's only by case is counted, not lost", () => {
  const scan = classify([
    { path: "Note.html", size: 40 },
    { path: "art/Cover.png", size: 100 },
    { path: "art/cover.PNG", size: 100 },
  ]);
  // the first keeps the key; the second is a skip rather than a silent overwrite
  assert.deepEqual([...scan.candidates.values()], ["art/Cover.png"]);
  assert.deepEqual(scan.skips, [
    { path: "art/cover.PNG", reason: "another file's path differs from it only by case" },
  ]);
  const parse = appleNotesParse(scan, new Map([["Note.html", "<div>hi</div>"]]), "export");
  // and both files are still accounted for: one unembedded, one case-collided
  assert.deepEqual(parse.skips.map((skip) => skip.path).sort(), ["art/Cover.png", "art/cover.PNG"]);
});

test("an export with nothing convertible offers no sample at all", () => {
  const scan = classify([{ path: "Blank.html", size: 20 }]);
  const parse = appleNotesParse(scan, new Map([["Blank.html", "<div> </div>"]]), "export");
  assert.equal(parse.sample, undefined);
  const plan = buildPlan("apple-notes", "~/export", parse, new Set(), new Set());
  assert.equal(plan.sample, undefined);
});
