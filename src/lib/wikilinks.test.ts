import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorLine,
  embedSize,
  embedSizeStyle,
  embedTarget,
  parseWikiLink,
  wikiLinkDisplay,
  wikiLinkInsert,
  wikiLinkOptions,
  wikiLinkQuery,
} from "./wikilinks.ts";

test("wikiLinkQuery: only inside an open [[", () => {
  assert.equal(wikiLinkQuery("[["), "");
  assert.equal(wikiLinkQuery("see [[Al"), "Al");
  assert.equal(wikiLinkQuery("a [[x]] then [[B"), "B");
  // a single bracket, a closed link, and a newline all end the link context
  assert.equal(wikiLinkQuery("see [Al"), null);
  assert.equal(wikiLinkQuery("see [[Al]]"), null);
  assert.equal(wikiLinkQuery("see [[Al\nmore"), null);
});

test("wikiLinkOptions: fuzzy ranking, misses and dupes dropped", () => {
  const titles = ["Alpha Notes", "Beta", "alphabet", "Zeta", "Beta"];
  const ranked = wikiLinkOptions("alp", titles).map((o) => o.title);
  // both prefix hits rank by length (shorter wins); Beta/Zeta don't match
  assert.deepEqual(ranked, ["alphabet", "Alpha Notes"]);
  assert.deepEqual(wikiLinkOptions("zzz", titles), []);
});

test("wikiLinkOptions: empty query lists every title A→Z, deduped", () => {
  const ranked = wikiLinkOptions("", ["Beta", "alpha", "Beta", "  "]).map((o) => o.title);
  assert.deepEqual(ranked, ["alpha", "Beta"]);
});

test("wikiLinkOptions: case-insensitive matching", () => {
  assert.deepEqual(wikiLinkOptions("ALP", ["alphabet"]).map((o) => o.title), ["alphabet"]);
});

test("wikiLinkInsert: closes the link unless ]] already follows", () => {
  assert.equal(wikiLinkInsert("Alpha Notes", ""), "Alpha Notes]]");
  assert.equal(wikiLinkInsert("Alpha Notes", " rest"), "Alpha Notes]]");
  assert.equal(wikiLinkInsert("Alpha Notes", "]] rest"), "Alpha Notes");
});

// twin of the Rust `wikilink_splits_into_target_anchor_alias`
// test (src-tauri/src/vault/mod.rs); keep the cases in step.
test("parseWikiLink: target, anchor and alias", () => {
  assert.deepEqual(parseWikiLink("Piranesi"), {
    target: "Piranesi",
    anchor: null,
    alias: null,
  });
  assert.deepEqual(parseWikiLink("Piranesi|the book"), {
    target: "Piranesi",
    anchor: null,
    alias: "the book",
  });
  assert.deepEqual(parseWikiLink("Piranesi#Notes"), {
    target: "Piranesi",
    anchor: "Notes",
    alias: null,
  });
  assert.deepEqual(parseWikiLink("Piranesi#Notes|the book"), {
    target: "Piranesi",
    anchor: "Notes",
    alias: "the book",
  });
  // whitespace around every piece, and a same-note anchor
  assert.deepEqual(parseWikiLink("  Piranesi # Notes | the book "), {
    target: "Piranesi",
    anchor: "Notes",
    alias: "the book",
  });
  assert.deepEqual(parseWikiLink("#Notes"), { target: "", anchor: "Notes", alias: null });
  // block ref; a `#` in the display text stays display text; first pipe wins
  assert.deepEqual(parseWikiLink("Piranesi#^a1b2"), {
    target: "Piranesi",
    anchor: "^a1b2",
    alias: null,
  });
  assert.deepEqual(parseWikiLink("Piranesi|see #Notes"), {
    target: "Piranesi",
    anchor: null,
    alias: "see #Notes",
  });
  assert.deepEqual(parseWikiLink("Piranesi|a|b"), {
    target: "Piranesi",
    anchor: null,
    alias: "a|b",
  });
});

test("wikiLinkDisplay: alias wins, else target#anchor", () => {
  assert.equal(wikiLinkDisplay("Piranesi"), "Piranesi");
  assert.equal(wikiLinkDisplay("Piranesi|the book"), "the book");
  assert.equal(wikiLinkDisplay("Piranesi#Notes"), "Piranesi#Notes");
  assert.equal(wikiLinkDisplay("Piranesi#Notes|the book"), "the book");
  assert.equal(wikiLinkDisplay("#Notes"), "#Notes");
});

test("anchorLine: heading match is literal and case-insensitive", () => {
  const text = ["intro", "## Notes", "body", "### Deeper Notes ###", "end"].join("\n");
  assert.equal(anchorLine(text, "Notes"), 2);
  assert.equal(anchorLine(text, "notes"), 2);
  // closing #'s are punctuation, not part of the heading text
  assert.equal(anchorLine(text, "Deeper Notes"), 4);
  // a partial name is not a match — a missing heading scrolls nowhere
  assert.equal(anchorLine(text, "Note"), null);
  assert.equal(anchorLine(text, ""), null);
});

test("anchorLine: a heading inside a fence is code, not a heading", () => {
  const text = ["```sh", "# Notes", "```", "## Notes"].join("\n");
  assert.equal(anchorLine(text, "Notes"), 4);
});

test("anchorLine: ^id finds the block that carries the ref", () => {
  const text = ["first", "the claim ^a1b2", "later"].join("\n");
  assert.equal(anchorLine(text, "^a1b2"), 2);
  assert.equal(anchorLine(text, "^nope"), null);
});

test("embedTarget: the display modifier is dropped, a # never is", () => {
  // Twin of embed_target in src-tauri/src/vault/mod.rs
  assert.equal(embedTarget("cover.png"), "cover.png");
  assert.equal(embedTarget("cover.png|300"), "cover.png");
  assert.equal(embedTarget("cover.png|300x200"), "cover.png");
  assert.equal(embedTarget("  cover.png | left "), "cover.png");
  // only the FIRST pipe splits
  assert.equal(embedTarget("cover.png|300|left"), "cover.png");
  // a `#` belongs to the filename — an embed has no anchor
  assert.equal(embedTarget("track #3.wav"), "track #3.wav");
  assert.equal(embedTarget("track #3.wav|200"), "track #3.wav");
  // link-in-place paths survive whole
  assert.equal(embedTarget("~/Music/mixdown.flac|300"), "~/Music/mixdown.flac");
  assert.equal(embedTarget("|300"), "");
});

test("embedSize: a bare number is a width, WxH is a box, everything else is ignored", () => {
  // twin of embed_size in src-tauri/src/vault/mod.rs; keep the
  // two tables identical, a divergence means the app and the engine disagree
  // about how big a note's images are.
  assert.deepEqual(embedSize("cover.png"), null);
  assert.deepEqual(embedSize("cover.png|300"), { width: 300, height: null });
  assert.deepEqual(embedSize("cover.png|300x200"), { width: 300, height: 200 });
  assert.deepEqual(embedSize("cover.png|300X200"), { width: 300, height: 200 });
  assert.deepEqual(embedSize("cover.png | 300 "), { width: 300, height: null });
  // floats are recognised syntax Substrate declines to act on
  assert.deepEqual(embedSize("cover.png|left"), null);
  assert.deepEqual(embedSize("cover.png|right"), null);
  // a float beside a width does not cost the width
  assert.deepEqual(embedSize("cover.png|300|left"), { width: 300, height: null });
  assert.deepEqual(embedSize("cover.png|left|300x200"), { width: 300, height: 200 });
  // garbage is ignored, never an error
  assert.deepEqual(embedSize("cover.png|axb"), null);
  assert.deepEqual(embedSize("cover.png|300x"), null);
  assert.deepEqual(embedSize("cover.png|x200"), null);
  assert.deepEqual(embedSize("cover.png|3.5"), null);
  assert.deepEqual(embedSize("cover.png|-3"), null);
  assert.deepEqual(embedSize("cover.png|0"), null);
  assert.deepEqual(embedSize("cover.png|0x0"), null);
  assert.deepEqual(embedSize("cover.png|"), null);
  assert.deepEqual(embedSize("cover.png|300x0"), null);
  // an absurd number degrades to a big image, never a broken one
  assert.deepEqual(embedSize("cover.png|99999"), { width: 4096, height: null });
  assert.deepEqual(embedSize("cover.png|99999x99999"), { width: 4096, height: 4096 });
});

test("embedSizeStyle: caps only, so images scale and keep their ratio", () => {
  assert.deepEqual(embedSizeStyle(null), {});
  assert.deepEqual(embedSizeStyle({ width: 300, height: null }), { maxWidth: "300px" });
  assert.deepEqual(embedSizeStyle({ width: 300, height: 200 }), {
    maxWidth: "300px",
    maxHeight: "200px",
  });
});
