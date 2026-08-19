/** The row projection and text marking behind a picture hit. The component
    test (`imageHit.component.test.ts`) proves the pane renders them; this
    pins the edges the pane never reaches. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_SCHEME, imageHitMeta, markQuery, parseImagePath, readingLabel } from "./images.ts";

test("only a picture row parses as one", () => {
  assert.equal(parseImagePath(`${IMAGE_SCHEME}Screens/a.png`), "Screens/a.png");
  assert.equal(parseImagePath("Notes/a.md"), null);
  assert.equal(parseImagePath("mount://drive/a.pdf"), null);
  // the scheme alone names no picture
  assert.equal(parseImagePath(IMAGE_SCHEME), null);
});

test("a picture row carries its folder, name and extension", () => {
  const m = imageHitMeta(`${IMAGE_SCHEME}Screens/2026/invoice.png`);
  assert.ok(m);
  assert.equal(m.folder, "Screens/2026");
  assert.equal(m.title, "invoice.png");
  assert.equal(m.props.type, "image");
  assert.equal(m.props.extension, "png");
  // no mtime to sort by, and sealing is a note's property
  assert.equal(m.updated_ms, 0);
  assert.equal(m.sealed, false);
  assert.equal(imageHitMeta("Notes/a.md"), null);
});

test("a picture at the vault root has no folder", () => {
  assert.equal(imageHitMeta(`${IMAGE_SCHEME}shot.png`)?.folder, "");
});

test("the query is marked where it landed, case folded, and nowhere else", () => {
  const parts = markQuery("Invoice 4711 total 19,00 EUR", ["4711", "eur"]);
  assert.deepEqual(
    parts.map((p) => [p.text, p.hit]),
    [
      ["Invoice ", false],
      ["4711", true],
      [" total 19,00 ", false],
      ["EUR", true],
    ]
  );
  // the parts always concatenate back to exactly the text handed in
  assert.equal(parts.map((p) => p.text).join(""), "Invoice 4711 total 19,00 EUR");
});

test("an unaccented query marks the accented word whole", () => {
  // the index folds diacritics, so "cafe" is what found this picture at all —
  // the mark has to land on "Café", accent included
  const parts = markQuery("Café Größe für 4711", ["cafe", "große", "fur"]);
  assert.deepEqual(
    parts.map((p) => [p.text, p.hit]),
    [
      ["Café", true],
      [" ", false],
      ["Größe", true],
      [" ", false],
      ["für", true],
      [" 4711", false],
    ]
  );
  // and the runs still concatenate back to exactly the accented text
  assert.equal(parts.map((p) => p.text).join(""), "Café Größe für 4711");
});

test("marks land past a multibyte character rather than beside it", () => {
  // an emoji is two UTF-16 code units; a match after it must not be off by one
  const text = "🎛 Café";
  const parts = markQuery(text, ["cafe"]);
  assert.deepEqual(
    parts.map((p) => [p.text, p.hit]),
    [
      ["🎛 ", false],
      ["Café", true],
    ]
  );
  assert.equal(parts.map((p) => p.text).join(""), text);
});

test("text nobody searched for is one unmarked run", () => {
  assert.deepEqual(markQuery("plain", []), [{ text: "plain", hit: false }]);
  assert.deepEqual(markQuery("plain", ["absent"]), [{ text: "plain", hit: false }]);
});

test("overlapping terms mark once rather than nesting", () => {
  const parts = markQuery("mastering", ["master", "mastering"]);
  assert.equal(parts.map((p) => p.text).join(""), "mastering");
  assert.equal(parts.filter((p) => p.hit).length, 1);
});

test("a picture read only in part says so beside the text", () => {
  const base = {
    rel: "a.png",
    source: "a.png",
    path: "/v/a.png",
    text: "x",
    label: "machine-read text, never ground truth",
    version: 1,
  };
  assert.equal(readingLabel({ ...base, truncated: false }), base.label);
  assert.match(readingLabel({ ...base, truncated: true }), /only the beginning was kept/);
});
