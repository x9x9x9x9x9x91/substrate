import { test } from "node:test";
import assert from "node:assert/strict";

// assets.ts resolves through the mock backend (src/lib/tauri.ts picks the
// mock when `window` has no __TAURI_INTERNALS__) — shim a bare window before
// importing so the module loads under plain node.
(globalThis as Record<string, unknown>).window = {};

const { audioSource, assetBlobUrl, mimeFor, resetAudioSources } = await import("./assets.ts");

test("mimeFor maps svg to image/svg+xml, unknown stays png (SUB-103)", () => {
  assert.equal(mimeFor("icon.svg"), "image/svg+xml");
  assert.equal(mimeFor("photo.JPG"), "image/jpeg");
  assert.equal(mimeFor("scan.avif"), "image/avif");
  assert.equal(mimeFor("IMG_0231.HEIC"), "image/heic");
  assert.equal(mimeFor("scan.heif"), "image/heic");
  assert.equal(mimeFor("pic.png"), "image/png");
  assert.equal(mimeFor("strange.bmp"), "image/png");
});

test("audioSource caches one promise per name until resetAudioSources (SUB-101)", async () => {
  const a1 = audioSource("loop-one.wav");
  const a2 = audioSource("loop-one.wav");
  assert.equal(a1, a2, "second call hits the session cache");
  const src = await a1;
  assert.match(src.cacheKey, /^mock:\/\/loop-one\.wav:/);
  resetAudioSources();
  const a3 = audioSource("loop-one.wav");
  assert.notEqual(a3, a1, "reset drops the cached resolution so the next use re-stats");
  const src3 = await a3;
  assert.ok(src3.cacheKey.length > 0);
});

test("resetAudioSources revokes cached blob URLs and clears the map (SUB-101)", async () => {
  const revoked: string[] = [];
  const orig = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u: string) => {
    revoked.push(u);
    orig(u);
  };
  try {
    const u1 = await assetBlobUrl("blueprint-sketch.png");
    assert.ok(u1.startsWith("blob:"), u1);
    assert.equal(await assetBlobUrl("blueprint-sketch.png"), u1, "cached across calls");
    resetAudioSources();
    // the revoke rides a promise continuation — let it land
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(revoked, [u1], "evicted object URLs are revoked");
    const u2 = await assetBlobUrl("blueprint-sketch.png");
    assert.notEqual(u2, u1, "blob URL re-created after reset");
  } finally {
    URL.revokeObjectURL = orig;
  }
});
