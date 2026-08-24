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

/** Every key the FIELDS array carries, fenced rows included. */
const allKeys = [...pane.matchAll(/^\s*key: "([^"]+)"/gm)].map((m) => m[1]);

/** The keys only the private build shows: a fenced row is stripped out of the
    public build, so its switch has no field there and no code that reads it. */
const fencedKeys = allKeys.filter((k) => !paneKeys.includes(k));

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

test("the fenced settings keys are the ones this suite expects", () => {
  // The public mirror ships this file with the fenced rows and the markers both
  // stripped, so there is no fence set to assert on there; the private tree is
  // where the fence set is enforced.
  if (!pane.includes(MARK)) return;
  // the seeded body must document neither, and a promotion that takes a fence
  // off is exactly when its bullet is owed — so name them rather than trust
  // the strip regex alone
  for (const k of ["net-letterbox", "net-lens"]) {
    assert.ok(fencedKeys.includes(k), `${k} is no longer a fenced pane key — if it was promoted, give it a bullet in seed.rs SETTINGS_BODY and drop it from this list`);
  }
});

test("no fenced pane key is documented in the seeded Settings.md body", () => {
  // The public mirror ships this file with the fenced rows and the markers both
  // stripped, so there is no fence set to assert on there; the private tree is
  // where the fence set is enforced.
  if (!pane.includes(MARK)) return;
  const body = seedFn![1];
  const leaked = fencedKeys.filter((k) => body.includes("- `" + k + "`"));
  assert.deepEqual(leaked, [], `seed.rs seed_settings documents keys the public build has no field for: ${leaked.join(", ")}`);
});
