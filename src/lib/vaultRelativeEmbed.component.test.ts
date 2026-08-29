/** An image embed that names its file by a path inside the vault, taken all
    the way to renderable bytes (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    Why this test and not a wider one: `asset_info` says where a file is, but
    an inline image reads its BYTES through `vault_read_asset`, and those were
    two different resolvers. `![[Files/Guides/console layout.png]]` located
    fine and rendered as a broken picture, and nothing caught it — the mock
    backend answered the read the engine refused, so every gate riding the
    browser lane stayed green over a break that only appears in the packaged
    app. So this pins both halves: the bytes arrive, and the mock refuses
    exactly what the engine refuses. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mockBackend } from "./componentHarness.ts";

before(async () => {
  await mockBackend();
});

test("an image embed named by its path inside the vault reaches renderable bytes", async () => {
  const { assetBlobUrl, imageSource } = await import("./assets.ts");
  const url = await assetBlobUrl("Files/Guides/console layout.png");
  assert.match(url, /^blob:/, "the editor's inline image path resolved the target");
  // and the same target through the widget's own resolver
  assert.match(await imageSource("Files/Guides/console layout.png"), /^blob:/);
});

test("a bare name still means .assets/ and does not reach into the vault", async () => {
  const { assetBlobUrl } = await import("./assets.ts");
  // the mock's own pasted asset, addressed the way it always was
  assert.match(await assetBlobUrl("blueprint-sketch.png"), /^blob:/);
});

test("the mock refuses every target the engine refuses", async () => {
  const { vaultReadAsset } = await import("./ipc.ts");
  // the same list `read_asset_takes_a_vault_relative_name_and_still_refuses_the_rest`
  // holds the engine to — a fixture that answered any of these would hide the
  // next break the way it hid this one
  for (const bad of [
    "Files/../Notes/x.png",
    "Files//console layout.png",
    "Files/.vault/views.json",
    ".assets/sleeve.png",
    "Files\\Guides\\console layout.png",
    "..",
  ]) {
    await assert.rejects(
      () => vaultReadAsset(bad),
      /invalid asset name/,
      `${bad} must be refused`
    );
  }
});
