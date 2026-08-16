/** `useAutoSync`'s boot race, run for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    App holds `auto-sync` in state that starts at the default ON and only
    becomes the vault's answer once its own Settings.md read resolves. The hook
    took that prop at face value, so a vault whose Settings.md says
    `auto-sync: false` still fired `start()`'s open pull — the one trigger that
    cannot be taken back, and the one a user who parked the lane would be most
    surprised by.

    The test stands exactly in that window: it renders with the prop App has at
    mount (`true`) over a Settings.md that says false, and asserts on the sync
    commands the mock recorded. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { SETTINGS_PATH } from "./settings.ts";

/** A configured remote and a clean pull waiting — everything the lane needs to
    fire, so a silent run is the setting's doing and nothing else's. */
async function armLane(win: MockWindow, autoSyncProp: string) {
  const { vaultSetProp, vaultSyncSetRemote } = await import("./ipc.ts");
  const { resetSyncConfigured } = await import("./embedstate.ts");
  await vaultSyncSetRemote("file:///tmp/vault-test-sync.git", "");
  resetSyncConfigured();
  win.__mockSetPull?.({ conflicted: false, changed: [] });
  win.__mockSetPrivacy?.(null);
  // Settings.md is its own store in the mock (the ⌘, sheet's note), so it is
  // written through the command the sheet uses, not the note-staging seam.
  await vaultSetProp(SETTINGS_PATH, "auto-sync", autoSyncProp);
}

/** Only the hook. App's own settings read is deliberately NOT simulated: the
    prop stays at the pre-read default for the whole test, which is the state
    the open pull used to land in. */
async function bootComponent() {
  const { useAutoSync } = await import("../hooks/useAutoSync.ts");
  return function Boot({ autoSync }: { autoSync: boolean }) {
    useAutoSync(autoSync);
    return h("div", null, String(autoSync));
  };
}

test("a vault that parked the lane gets no open pull, prop or no prop", async (t) => {
  const win = await mockBackend();
  await armLane(win, "false");
  const before = win.__mockSyncCalls?.() ?? [];

  const r = await renderComponent(t, h(await bootComponent(), { autoSync: true }));
  // the boot read is two awaits deep (configured + Settings.md); settle again
  // so a pull that WOULD have fired has had every chance to
  await r.settle();

  const fired = (win.__mockSyncCalls?.() ?? []).slice(before.length);
  assert.deepEqual(fired, [], `the parked lane synced anyway: ${fired.join(", ")}`);
});

test("…and the same boot with auto-sync on does pull, so the test can see one", async (t) => {
  const win = await mockBackend();
  await armLane(win, "true");
  const before = win.__mockSyncCalls?.() ?? [];

  const r = await renderComponent(t, h(await bootComponent(), { autoSync: true }));
  await r.settle();

  const fired = (win.__mockSyncCalls?.() ?? []).slice(before.length);
  assert.deepEqual(fired, ["vault_sync_pull"], "the open pull never ran");
});
