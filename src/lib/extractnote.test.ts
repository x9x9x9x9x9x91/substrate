import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLink, extractTitle } from "./extractnote.ts";

test("extractTitle: first non-blank line wins", () => {
  assert.equal(extractTitle("plain words here"), "plain words here");
  assert.equal(extractTitle("\n\n  \nsecond line\nthird"), "second line");
});

test("extractTitle: block marks strip, content stays", () => {
  assert.equal(extractTitle("## A heading"), "A heading");
  assert.equal(extractTitle("- a bullet"), "a bullet");
  assert.equal(extractTitle("- [x] a done task"), "a done task");
  assert.equal(extractTitle("3. an ordered item"), "an ordered item");
  assert.equal(extractTitle("> a quote"), "a quote");
  assert.equal(extractTitle("> [!warn] a callout"), "a callout");
  assert.equal(extractTitle("> ## nested marks"), "nested marks");
});

test("extractTitle: inline marks strip, labels survive", () => {
  assert.equal(extractTitle("**bold** and *em* and `code`"), "bold and em and code");
  assert.equal(extractTitle("see [[Some Note]] here"), "see Some Note here");
  assert.equal(extractTitle("[a label](https://x.test) link"), "a label link");
});

test("extractTitle: a parenthesized URL strips whole — no stray ) (SUB-919)", () => {
  // the SUB-902/912 regex family: destination keeps one balanced paren level
  assert.equal(
    extractTitle("See [wiki](https://en.wikipedia.org/wiki/Granular_(synthesis)) for background"),
    "See wiki for background"
  );
  // embeds with the same destination shape strip too
  assert.equal(extractTitle("![shot](shots/a_(v2).png) caption"), "shot caption");
});

test("extractTitle: whitespace collapses, sentence stops drop", () => {
  assert.equal(extractTitle("  many   spaces\tand\ttabs  "), "many spaces and tabs");
  assert.equal(extractTitle("a full sentence."), "a full sentence");
  assert.equal(extractTitle("really?!"), "really");
});

test("extractTitle: truncation prefers a word boundary", () => {
  const long = "word ".repeat(20).trim(); // 99 chars
  const title = extractTitle(long);
  assert.ok(title.length <= 60);
  assert.ok(!title.endsWith(" "));
  assert.equal(title, long.split(" ").slice(0, 12).join(" ")); // 59 chars
  // no usable boundary → hard cut
  assert.equal(extractTitle("x".repeat(80)).length, 60);
});

test("extractTitle: truncation never splits a surrogate pair", () => {
  const title = extractTitle("🎛️".repeat(40)); // astral pairs + variation selectors
  assert.ok(!/[\uD800-\uDBFF]$/.test(title), `lone high surrogate at the cut: ${title}`);
  assert.equal(Array.from(title).length, 60);
});

test("extractTitle: chars the engine refuses are stripped", () => {
  // vault.rs validate_note_title: no [ or ], no leading dot
  assert.equal(extractTitle("See [1] above for detail"), "See 1 above for detail");
  assert.equal(extractTitle("the array[0] value"), "the array0 value");
  assert.equal(extractTitle(".env notes here"), "env notes here");
});

test("extractTitle: empty or all-marks selections fall back to Untitled", () => {
  assert.equal(extractTitle(""), "Untitled");
  assert.equal(extractTitle("   \n \n"), "Untitled");
  assert.equal(extractTitle("## "), "Untitled");
  assert.equal(extractTitle("[[]] ..."), "Untitled");
});

test("extractLink: the vault's wikilink form", () => {
  assert.equal(extractLink("Some Note"), "[[Some Note]]");
});
