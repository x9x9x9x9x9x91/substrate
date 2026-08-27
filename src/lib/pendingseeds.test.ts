import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta } from "./types.ts";

/* Seeds staged before the mock module evaluates must be in the vault by the
   time the very first command is served — the deterministic replacement for
   an init script polling for the seed hooks, which can land its seed after
   the app's first listing under load. Staging happens here BEFORE the
   import, exactly the order addInitScript runs in ahead of the app's
   modules; node runs each test file in its own process, so this import is
   fresh and the drain actually executes. */
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { __mockPendingSeeds?: unknown[] }).__mockPendingSeeds = [
  { notes: { folder: "Inbox", count: 3 } },
  { matching: { folder: "Bulk", count: 2, token: "stagedtoken", where: "title" } },
];
const { invoke } = await import("./tauri.ts");

test("staged pending seeds are in the vault before the first listing", async () => {
  const notes = await invoke<NoteMeta[]>("vault_list");
  const seeded = notes.filter((n) => /^Inbox\/Seeded \d{4}\.md$/.test(n.path));
  assert.equal(seeded.length, 3);
  const matching = notes.filter((n) => n.title.includes("stagedtoken"));
  assert.equal(matching.length, 2);
  // the staging array is consumed at install — nothing left to double-drain
  assert.equal(
    (globalThis as { __mockPendingSeeds?: unknown }).__mockPendingSeeds,
    undefined
  );
});
