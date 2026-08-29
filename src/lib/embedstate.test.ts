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

test("a vault-relative embed is unsynced only inside an excluded folder", () => {
  const exclude = ["Files"];
  // the folder exists to hold what does not travel: a missing file there is
  // the design working, and reads with the vocabulary that already says so
  assert.equal(classifyMissingEmbed("Files/Guides/setup.pdf", true, exclude), "unsynced");
  assert.equal(classifyMissingEmbed("Files/cover.png", true, exclude), "unsynced");
  // a folder that DOES travel has no such excuse — the file is gone
  assert.equal(classifyMissingEmbed("Papers/setup.pdf", true, exclude), "broken");
  // and a prefix is not a parent folder
  assert.equal(classifyMissingEmbed("Filesystem/setup.pdf", true, exclude), "broken");
  // nested exclusions carry their whole subtree, and only their subtree
  assert.equal(classifyMissingEmbed("Media/Raw/take.wav", true, ["Media/Raw"]), "unsynced");
  assert.equal(classifyMissingEmbed("Media/mix.wav", true, ["Media/Raw"]), "broken");
});

test("an unconfigured exclusion list leaves vault-relative embeds broken", () => {
  // the caller passing no list is saying it does not know — never guess a
  // reassuring answer, since a real deletion would then read as "not here yet"
  assert.equal(classifyMissingEmbed("Files/Guides/setup.pdf", true), "broken");
  // a bare .assets/ name is unaffected: its exclusion is the sync leg's own,
  // not a folder the vault configured
  assert.equal(classifyMissingEmbed("setup.pdf", true), "unsynced");
});

test("no sync remote keeps a vault-relative embed broken whatever is excluded", () => {
  assert.equal(classifyMissingEmbed("Files/Guides/setup.pdf", false, ["Files"]), "broken");
});

test("a target the vault's grammar refuses is broken, never left behind", () => {
  const exclude = ["Files"];
  // all three start inside the excluded folder by naive prefix, and none of
  // them names a file any device could hold: saying "not on this device" would
  // send the reader looking somewhere the file was never going to be
  assert.equal(classifyMissingEmbed("Files/../Notes/x.pdf", true, exclude), "broken");
  assert.equal(classifyMissingEmbed("Files//x.pdf", true, exclude), "broken");
  assert.equal(classifyMissingEmbed("Files/.vault/x", true, exclude), "broken");
  // a backslash is a separator in disguise, not a filename character
  assert.equal(classifyMissingEmbed("Files\\Guides\\x.pdf", true, exclude), "broken");
  // and a bare name that tries to climb is not a .assets/ name either
  assert.equal(classifyMissingEmbed("..", true, exclude), "broken");
  // the well-formed sibling of the first one still reads as left behind
  assert.equal(classifyMissingEmbed("Files/Notes/x.pdf", true, exclude), "unsynced");
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
