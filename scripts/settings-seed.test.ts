import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The seeded Settings.md body (seed.rs seed_settings) is the app's own
// self-documentation — the file users hand-edit, where each key gets a
// bullet. It drifted five keys behind the ⌘, pane once already (
// mod-hud, terminal-dock, terminal-width, share-relay-*). This suite pins
// the two sources together so a new pane field fails `npm test` until the
// seed body documents it.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const pane = readFileSync(join(ROOT, "src/components/SettingsPane.tsx"), "utf8");
const seed = readFileSync(join(ROOT, "src-tauri/src/vault/seed.rs"), "utf8");

/** Fields inside share-mirror strip markers are private and unreleased, and
    seed.rs ships to the public mirror unchanged — documenting one there would
    hand a public reader a key their build has no field for. So a fenced field
    is exempt from the seed body, and stops being exempt the moment it is
    promoted and the fence comes off.

    The marker name is assembled rather than written out, and this file ships
    to the mirror, so it must not contain the marker at all: share-mirror.sh
    matches the markers as bare substrings line by line, so one line carrying
    both would read as a start with no end, and its denylist treats a marker
    surviving into the mirror as a strip that silently failed. */
const MARK = "share-mirror" + ":strip";
const shared = pane.replace(new RegExp(`${MARK}-start[\\s\\S]*?${MARK}-end`, "g"), "");

/** Every settings key the ⌘, form manages (the FIELDS array). */
const paneKeys = [...shared.matchAll(/^\s*key: "([^"]+)"/gm)].map((m) => m[1]);

/** The seeded Settings.md body: the SETTINGS_BODY literal (split off
    the frontmatter so the body can be refreshed in existing vaults). */
const seedFn = /pub\(crate\) const SETTINGS_BODY: &str = "([\s\S]*?)";/.exec(seed);

test("seed_settings body exists where this test expects it", () => {
  assert.ok(seedFn, "seed.rs SETTINGS_BODY literal not found — update this test's regex");
});

test("every ⌘, pane key is documented in the seeded Settings.md body", () => {
  assert.ok(paneKeys.length >= 15, `pane FIELDS parse looks broken (found ${paneKeys.length} keys)`);
  const body = seedFn![1];
  const missing = paneKeys.filter((k) => !body.includes("- `" + k + "`"));
  assert.deepEqual(missing, [], `keys missing a bullet in seed.rs seed_settings: ${missing.join(", ")}`);
});
