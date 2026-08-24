import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/* The phone webview zooms the whole page in when a field whose font-size is
   under 16px receives focus — and the zoom outlives the keyboard, leaving
   every surface clipped and side-scrolling until the app restarts. No gate
   engine applies viewport meta (desktop webviews ignore it entirely), so the
   only thing standing between "works" and "every phone surface overflows" is
   the literal text of this one tag. This pins it. */

const INDEX_PATH = new URL("../../index.html", import.meta.url);

test("the viewport meta pins the phone webview at 1:1", () => {
  // Comments stripped first, and exactly one live tag required: the webview
  // honors the LAST viewport meta it sees, so a stray second tag (or a good
  // tag surviving only inside a comment) would pass a first-match check
  // while the app ships broken.
  const html = readFileSync(INDEX_PATH, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const tags = [...html.matchAll(/<meta\s+name="viewport"\s+content="([^"]*)"/g)];
  assert.equal(tags.length, 1, "index.html declares exactly one live viewport meta tag");
  const directives = tags[0][1].split(",").map((part) => part.trim());
  for (const required of [
    "width=device-width",
    "initial-scale=1.0",
    "maximum-scale=1.0",
    "user-scalable=no",
  ]) {
    assert.ok(
      directives.includes(required),
      `viewport meta carries ${required} (got: ${tags[0][1]})`,
    );
  }
});
