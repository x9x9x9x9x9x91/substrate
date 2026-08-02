import { test } from "node:test";
import assert from "node:assert/strict";
import { wikiLinkInsert, wikiLinkOptions, wikiLinkQuery } from "./wikilinks.ts";

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
