import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOneSheet,
  buildTableSheet,
  dateColumns,
  dropEmbedOnce,
  numericColumns,
  oneSheetFacts,
  oneSheetHero,
} from "./onesheet.ts";
import type { NoteMeta } from "./types.ts";

const noAssets = () => undefined;
const pngFor = (name: string) => (n: string) =>
  n === name ? "data:image/png;base64,AA" : undefined;

const meta = (title: string, props: Record<string, unknown>): NoteMeta => ({
  path: `${title}.md`,
  stem: title,
  title,
  folder: "",
  props,
  updated_ms: 0,
  excerpt: "",
  sealed: false,
});

/* ── facts ──────────────────────────────────────────────────── */

test("oneSheetFacts: label facts lead in press order, dedicated slots stay out", () => {
  const facts = oneSheetFacts({
    type: "release",
    title: "x",
    artist: "chroma weather",
    artwork: "cover.png",
    created: "2026-07-17",
    venue: "Berlin",
    status: "live",
    "cat#": "SMP-028",
    tracks: "6",
  });
  assert.deepEqual(
    facts.map(([k]) => k),
    ["status", "cat#", "tracks", "venue"]
  );
});

test("oneSheetFacts: empty and non-scalar values drop; lists join like propStr", () => {
  const facts = oneSheetFacts({ format: ["Vinyl", "Digital"], contact: "", notes: undefined });
  assert.deepEqual(facts, [["format", "Vinyl, Digital"]]);
});

/* ── hero ───────────────────────────────────────────────────── */

test("oneSheetHero: the artwork prop wins, embed forms unwrap", () => {
  const hero = oneSheetHero(
    { artwork: "![[cover.png]]" },
    "![[other.png]]",
    pngFor("cover.png")
  );
  assert.equal(hero?.name, "cover.png");
});

test("oneSheetHero: falls back to the first body image embed", () => {
  const hero = oneSheetHero({}, "intro\n\n![[shot.png]]\n", pngFor("shot.png"));
  assert.equal(hero?.name, "shot.png");
});

test("oneSheetHero: unresolvable art means no hero, never a placeholder", () => {
  assert.equal(oneSheetHero({ artwork: "gone.png" }, "", noAssets), null);
  assert.equal(oneSheetHero({}, "no images here", noAssets), null);
});

test("dropEmbedOnce removes exactly the hoisted embed", () => {
  const body = "![[a.png]]\ntext\n![[a.png]]";
  assert.equal(dropEmbedOnce(body, "a.png"), "text\n![[a.png]]");
});

test("dropEmbedOnce: a hoisted embed with a display modifier still goes", () => {
  // The hero's name is the target alone, so the sized embed that
  // produced it has to match — else the press sheet prints the cover twice.
  assert.equal(dropEmbedOnce("![[a.png|300]]\ntext", "a.png"), "text");
  assert.equal(dropEmbedOnce("![[a.png|300x200]]\ntext", "a.png"), "text");
  assert.equal(dropEmbedOnce("![[ a.png | left ]]\ntext", "a.png"), "text");
  // a different file is still left alone
  assert.equal(dropEmbedOnce("![[b.png|300]]\ntext", "a.png"), "![[b.png|300]]\ntext");
});

test("oneSheetHero + buildOneSheet: a sized body embed is hoisted, not doubled", () => {
  // Before the modifier split this embed resolved to no image at
  // all, so the sheet had no hero; now it has one and must not also inline it.
  const hero = oneSheetHero({}, "intro\n\n![[shot.png|400]]\n", pngFor("shot.png"));
  assert.equal(hero?.name, "shot.png");
  const html = buildOneSheet({
    title: "Sized",
    props: {},
    body: "intro\n\n![[shot.png|400]]\n",
    assetSrc: pngFor("shot.png"),
  });
  assert.equal(html.match(/<img class="os-art"/g)?.length, 1);
  assert.doesNotMatch(html, /shot\.png\|400/);
});

/* ── one-sheet document ─────────────────────────────────────── */

test("buildOneSheet: hero + title + byline + facts + body, hero not doubled", () => {
  const html = buildOneSheet({
    title: "Static Bouquet",
    props: { type: "release", artist: "chroma weather", status: "live", artwork: "cover.png" },
    body: "The blue series.\n\n![[cover.png]]\n",
    assetSrc: pngFor("cover.png"),
  });
  assert.match(html, /<img class="os-art" src="data:image\/png;base64,AA"/);
  assert.match(html, /<h1 class="os-title">Static Bouquet<\/h1>/);
  assert.match(html, /<div class="os-byline">chroma weather<\/div>/);
  assert.match(html, /os-fact-label">status<.*os-fact-value">live</);
  // the artwork embed was hoisted into the hero — the body holds no copy
  assert.equal(html.match(/<img /g)?.length, 1);
});

test("buildOneSheet: byline falls back to type; no art, no facts, no body → head only", () => {
  const html = buildOneSheet({ title: "Bare", props: { type: "release" }, body: "", assetSrc: noAssets });
  assert.match(html, /<div class="os-byline">release<\/div>/);
  assert.ok(!html.includes("os-art"));
  assert.ok(!html.includes("os-facts"));
  assert.ok(!html.includes("os-body"));
});

test("buildOneSheet: titles and prop values escape", () => {
  const html = buildOneSheet({
    title: "<b>Rock & Roll</b>",
    props: { status: '"live" <now>' },
    body: "",
    assetSrc: noAssets,
  });
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;b&gt;Rock &amp; Roll/);
  assert.match(html, /&quot;live&quot; &lt;now&gt;/);
});

/* ── table sheet ────────────────────────────────────────────── */

test("numericColumns: all-numeric columns detect, mixed and empty ones don't", () => {
  const rows = [
    meta("a", { tracks: "6", price: "12.50", note: "6 of them" }),
    meta("b", { tracks: "11", note: "words" }),
    meta("c", { empty: "" }),
  ];
  const num = numericColumns(["tracks", "price", "note", "empty", "absent"], rows);
  assert.deepEqual([...num].sort(), ["price", "tracks"]);
});

test("dateColumns: all-ISO-date columns detect and class as nowrap dates", () => {
  const rows = [
    meta("a", { released: "2026-06-19", note: "2026-06-19 or so" }),
    meta("b", { released: "2025-10-23" }),
  ];
  const num = dateColumns(["released", "note"], rows);
  assert.deepEqual([...num], ["released"]);
  const html = buildTableSheet({ name: "R", columns: ["released"], rows, date: "x" });
  assert.match(html, /<td class="ts-date">2026-06-19<\/td>/);
});

test("buildTableSheet: view columns and order, name first, numerics classed", () => {
  const rows = [
    meta("Vessel Songs", { status: "mastering", tracks: "12" }),
    meta("Static Bouquet", { status: "live", tracks: "6" }),
  ];
  const html = buildTableSheet({ name: "Release", columns: ["status", "tracks"], rows, date: "2 Aug 2026" });
  assert.match(html, /<h1 class="ts-title">Release<\/h1>/);
  assert.match(html, /2 entries<span class="print-sep"> · <\/span>2 Aug 2026/);
  assert.match(html, /<th class="ts-name">Name<\/th><th class="">status<\/th><th class="ts-num">tracks<\/th>/);
  // row order preserved, name cell first
  const first = html.indexOf("Vessel Songs");
  const second = html.indexOf("Static Bouquet");
  assert.ok(first !== -1 && first < second);
  assert.match(html, /<td class="ts-num">12<\/td>/);
});

test("buildTableSheet: grouped duplicates collapse like the CSV export (SUB-563)", () => {
  const n = meta("Twice", { format: "Vinyl" });
  const html = buildTableSheet({ name: "Release", columns: ["format"], rows: [n, n], date: "x" });
  assert.equal(html.match(/Twice/g)?.length, 1);
  assert.match(html, /1 entry</);
});

test("buildTableSheet: cell values escape", () => {
  const rows = [meta("A & B", { note: "<script>" })];
  const html = buildTableSheet({ name: "N", columns: ["note"], rows, date: "x" });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /A &amp; B/);
});
