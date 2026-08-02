import { test } from "node:test";
import assert from "node:assert/strict";

// embedstate.ts pulls ipc.ts, which resolves through the mock backend
// (src/lib/tauri.ts picks the mock when `window` has no __TAURI_INTERNALS__)
// — shim a bare window before importing so the module loads under plain node.
(globalThis as Record<string, unknown>).window = {};

const { classifyMissingEmbed, missingEmbedLabel, syncConfigured, resetSyncConfigured } =
  await import("./embedstate.ts");

test("a synced vault classifies a missing .assets/ embed as unsynced (SUB-444)", () => {
  assert.equal(classifyMissingEmbed("bounce.wav", true), "unsynced");
  assert.equal(classifyMissingEmbed("sleeve.png", true), "unsynced");
  assert.equal(classifyMissingEmbed("contract.pdf", true), "unsynced");
});

test("no sync remote means every missing embed is genuinely broken (SUB-444)", () => {
  // nothing could have failed to arrive — a gap here is a deleted file
  assert.equal(classifyMissingEmbed("bounce.wav", false), "broken");
  assert.equal(classifyMissingEmbed("/Users/demo/Music/master.wav", false), "broken");
});

test("link-in-place paths stay broken even on a synced vault (SUB-444)", () => {
  // `.assets/` is what gitsync excludes (gitsync.rs:233) — an absolute or
  // ~ path was never in the repo, so its absence is not a sync gap
  assert.equal(classifyMissingEmbed("/Volumes/Studio/master.wav", true), "broken");
  assert.equal(classifyMissingEmbed("~/Music/master.wav", true), "broken");
});

test("labels keep the existing missing idiom per kind (SUB-444)", () => {
  assert.equal(missingEmbedLabel("broken", "audio", "gone.wav"), "missing audio · gone.wav");
  assert.equal(missingEmbedLabel("broken", "image", "gone.png"), "missing image · gone.png");
  assert.equal(missingEmbedLabel("unsynced", "file", "gone.pdf"), "not on this device · gone.pdf");
});

test("syncConfigured caches one lookup and resets on demand (SUB-444)", async () => {
  resetSyncConfigured();
  const a = syncConfigured();
  assert.equal(a, syncConfigured(), "second call hits the cached promise");
  // the mock backend starts with no remote configured
  assert.equal(await a, false);
  resetSyncConfigured();
  assert.notEqual(syncConfigured(), a, "reset drops the cached answer");
});
