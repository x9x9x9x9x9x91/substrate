import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorLine,
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

// SUB-1095 — twin of the Rust `wikilink_splits_into_target_anchor_alias`
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
