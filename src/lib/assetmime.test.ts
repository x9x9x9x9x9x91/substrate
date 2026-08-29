/* `mimeFor` stamps the content type on blobs built from `.assets/` files.
   assets.ts pulls in the mock backend, which reads vite's `import.meta.env`,
   so it is imported after the harness has installed its transform — a static
   import would be loaded before the hook exists. */
import "./componentHarness.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const { mimeFor } = await import("./assets.ts");

test("mimeFor types a pdf as a pdf, not as the image default", () => {
  assert.equal(mimeFor("report.pdf"), "application/pdf");
  assert.equal(mimeFor("Contract Final.PDF"), "application/pdf");
});

test("mimeFor still types the image set it was written for", () => {
  assert.equal(mimeFor("cover.jpg"), "image/jpeg");
  assert.equal(mimeFor("cover.jpeg"), "image/jpeg");
  assert.equal(mimeFor("loop.gif"), "image/gif");
  assert.equal(mimeFor("art.webp"), "image/webp");
  assert.equal(mimeFor("logo.svg"), "image/svg+xml");
  assert.equal(mimeFor("still.avif"), "image/avif");
  assert.equal(mimeFor("IMG_0231.heic"), "image/heic");
  assert.equal(mimeFor("scan.heif"), "image/heic");
  assert.equal(mimeFor("pixel.png"), "image/png");
});

test("an unknown extension keeps falling back to the image default", () => {
  assert.equal(mimeFor("notes.docx"), "image/png");
  assert.equal(mimeFor("noextension"), "image/png");
});
