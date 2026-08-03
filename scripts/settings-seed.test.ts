import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The seeded Settings.md body (seed.rs seed_settings) is the app's own
// self-documentation — the file users hand-edit, where each key gets a
// bullet. It drifted five keys behind the ⌘, pane once already (SUB-897:
// mod-hud, terminal-dock, terminal-width, share-relay-*). This suite pins
// the two sources together so a new pane field fails `npm test` until the
// seed body documents it.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const pane = readFileSync(join(ROOT, "src/components/SettingsPane.tsx"), "utf8");
const seed = readFileSync(join(ROOT, "src-tauri/src/vault/seed.rs"), "utf8");

/** Every settings key the ⌘, form manages (the FIELDS array). */
const paneKeys = [...pane.matchAll(/^\s*key: "([^"]+)"/gm)].map((m) => m[1]);

/** The seeded Settings.md body: the one string literal in seed_settings.
    Matched from the fn so a second seeded file can't satisfy the test. */
const seedFn = /pub\(crate\) fn seed_settings[\s\S]*?write_atomic\(\s*&abs,\s*"([\s\S]*?)",\s*\)/.exec(
  seed
);

test("seed_settings body exists where this test expects it", () => {
  assert.ok(seedFn, "seed.rs seed_settings write_atomic literal not found — update this test's regex");
});

test("every ⌘, pane key is documented in the seeded Settings.md body", () => {
  assert.ok(paneKeys.length >= 15, `pane FIELDS parse looks broken (found ${paneKeys.length} keys)`);
  const body = seedFn![1];
  const missing = paneKeys.filter((k) => !body.includes("- `" + k + "`"));
  assert.deepEqual(missing, [], `keys missing a bullet in seed.rs seed_settings: ${missing.join(", ")}`);
});
