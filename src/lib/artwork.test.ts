import { test } from "node:test";
import assert from "node:assert/strict";
import { artworkTarget, firstImageEmbed, isImageName, unwrapEmbed } from "./artwork.ts";

test("isImageName accepts image extensions, rejects the rest", () => {
  assert.equal(isImageName("cover.png"), true);
  assert.equal(isImageName("Art Final.JPEG"), true);
  assert.equal(isImageName(" sleeve.webp "), true);
  assert.equal(isImageName("IMG_0231.HEIC"), true);
  assert.equal(isImageName("scan.heif"), true);
  assert.equal(isImageName("still.avif"), true);
  assert.equal(isImageName("master.wav"), false);
  assert.equal(isImageName("notes.md"), false);
  assert.equal(isImageName("png"), false);
});

test("artworkTarget normalizes bare names, paths, and embed wrappers", () => {
  assert.equal(artworkTarget({ artwork: "cover.png" }), "cover.png");
  assert.equal(artworkTarget({ artwork: "  /abs/art.jpg " }), "/abs/art.jpg");
  assert.equal(artworkTarget({ artwork: "![[sleeve v2.png]]" }), "sleeve v2.png");
  assert.equal(artworkTarget({ artwork: "[[sleeve.png]]" }), "sleeve.png");
  assert.equal(artworkTarget({ artwork: "" }), null);
  assert.equal(artworkTarget({ artwork: "![[ ]]" }), null);
  assert.equal(artworkTarget({}), null);
  assert.equal(artworkTarget({ artwork: 3 }), null);
});

test("unwrapEmbed strips full-value embed wrappers, passes the rest through", () => {
  assert.equal(unwrapEmbed("![[cover.png]]"), "cover.png");
  assert.equal(unwrapEmbed("[[Some Note]]"), "Some Note");
  assert.equal(unwrapEmbed("  assets/cover.png "), "assets/cover.png");
  // not a full wrap → untouched
  assert.equal(unwrapEmbed("![[a.png]] and text"), "![[a.png]] and text");
  assert.equal(unwrapEmbed(""), "");
});

test("firstImageEmbed finds the first image, skipping audio embeds", () => {
  assert.equal(firstImageEmbed("intro\n![[master.wav]]\n![[art.png]]\n"), "art.png");
  assert.equal(firstImageEmbed("![[a.jpg]] then ![[b.png]]"), "a.jpg");
  assert.equal(firstImageEmbed("no embeds here"), null);
  assert.equal(firstImageEmbed("![[take.flac]]"), null);
});

test("a cased Artwork: key still names the cover (SUB-921)", () => {
  assert.equal(artworkTarget({ Artwork: "cover.png" }), "cover.png");
});
