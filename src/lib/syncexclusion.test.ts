import { test } from "node:test";
import assert from "node:assert/strict";

// syncexclusion.ts pulls ipc.ts, which resolves through the mock backend
// (src/lib/tauri.ts picks the mock when `window` has no __TAURI_INTERNALS__)
// — shim a bare window before importing so the module loads under plain node.
(globalThis as Record<string, unknown>).window = {};

const { excludedFolders, isExcludedPath, resetSyncExclusions } = await import(
  "./syncexclusion.ts"
);
const { normalizeFolder } = await import("./embedtarget.ts");

test("folder paths normalize to the one shape the config and the vault agree on", () => {
  assert.equal(normalizeFolder("Files"), "Files");
  assert.equal(normalizeFolder("/Files/"), "Files");
  assert.equal(normalizeFolder("Media//Raw/"), "Media/Raw");
  assert.equal(normalizeFolder(""), "");
  assert.equal(normalizeFolder("///"), "");
});

test("a path is excluded by its folder, never by a shared prefix", () => {
  assert.ok(isExcludedPath("Files", ["Files"]), "the folder itself counts");
  assert.ok(isExcludedPath("Files/Guides/setup.pdf", ["Files"]));
  assert.ok(isExcludedPath("Files/Guides", ["Files"]));
  // "Filesystem" merely starts with the same letters — a different folder
  assert.ok(!isExcludedPath("Filesystem/setup.pdf", ["Files"]));
  assert.ok(!isExcludedPath("Notes/setup.pdf", ["Files"]));
  // excluding a child never excludes its parent
  assert.ok(!isExcludedPath("Media", ["Media/Raw"]));
  assert.ok(isExcludedPath("Media/Raw/take.wav", ["Media/Raw"]));
});

test("untrimmed and empty config entries can't exclude the whole vault", () => {
  assert.ok(isExcludedPath("Files/x.pdf", ["/Files/"]), "the entry is trimmed, not rejected");
  // an empty entry normalizes to "" — which would otherwise be a prefix of
  // every path in the vault and silently excuse every missing file there
  assert.ok(!isExcludedPath("Notes/x.pdf", [""]));
  assert.ok(!isExcludedPath("Notes/x.pdf", ["/"]));
  assert.ok(!isExcludedPath("Notes/x.pdf", []));
});

test("the excluded list is the engine's own answer, cached once and resettable", async () => {
  resetSyncExclusions();
  const a = excludedFolders();
  assert.equal(a, excludedFolders(), "second call hits the cached promise");
  // read from sync_folders_list, so the list is whatever the vault actually
  // has excluded rather than a second copy of the default kept over here
  assert.deepEqual([...(await a)], ["Files", "Samples"]);
  resetSyncExclusions();
  assert.notEqual(excludedFolders(), a, "reset drops the cached answer");
});
