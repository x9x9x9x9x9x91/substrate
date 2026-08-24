/** `useAutoSync`'s mid-session arming, run for real through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A vault with no remote boots with the lane's `configured` gate shut, and it
    used to stay shut for the rest of the run: saving a remote from the Sync
    pane left settle-push, focus pull and interval pull dead until a reload,
    while the pane read Ready with the toggle ON. Nothing said so.

    The save's signal is embedstate's cache drop — `vaultSyncSetRemote` then
    `resetSyncConfigured()`, which is exactly what the pane's save-success path
    does (`VaultSyncPane.tsx`, the try block's tail). The button itself is the
    e2e's job (`e2e/syncui.spec.ts`); what is pinned here is the lane's answer
    to the signal, including the two things arming must NOT do: pull because of
    the save, and wake a vault that parked the lane.

    Real timers, shortened through the `__mockAutoSync` seam — the debounce
    ships at two minutes. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { SETTINGS_PATH } from "./settings.ts";

/** Short enough to watch, long enough that a machine under load does not push
    twice; the pull legs are parked far away so every pull this file sees is
    one the save is answerable for. */
const FAST = {
  pushDebounceMs: 20,
  pushMaxDirtyMs: 40,
  pullIntervalMs: 600_000,
  focusGapMs: 600_000,
};

/** Past the debounce with room to spare, then let the command's promise land. */
async function afterTheDebounce(settle: () => Promise<void>) {
  await new Promise((done) => setTimeout(done, 150));
  await settle();
}

/** Only the hook, and the prop App actually holds at mount: the pre-read
    default ON. The vault's own answer comes from Settings.md, as in the boot
    spec next door. */
async function bootComponent() {
  const { useAutoSync } = await import("../hooks/useAutoSync.ts");
  return function Boot({ autoSync }: { autoSync: boolean }) {
    useAutoSync(autoSync);
    return h("div", null, String(autoSync));
  };
}

/** What the Sync pane does the moment a remote save succeeds. */
async function saveRemote() {
  const { vaultSyncSetRemote } = await import("./ipc.ts");
  const { resetSyncConfigured } = await import("./embedstate.ts");
  await vaultSyncSetRemote("file:///tmp/vault-test-sync.git", "");
  resetSyncConfigured();
}

/** A vault change of the kind the lane hears synchronously at the invoke
    return — a prop edit is a watched write. */
async function editTheVault(value: string) {
  const { vaultSetProp } = await import("./ipc.ts");
  await vaultSetProp("Welcome.md", "mood", value);
}

async function stageSettings(autoSyncProp: string) {
  const { vaultSetProp } = await import("./ipc.ts");
  await vaultSetProp(SETTINGS_PATH, "auto-sync", autoSyncProp);
}

/* The remote saved in the first test stays saved for the second — the mock
   backend is module state and has no un-configure command. That is why the
   arming test runs first, on the only unconfigured boot this file gets. */

test("a remote saved mid-session arms the lane, without a pull of its own", async (t) => {
  const win: MockWindow = await mockBackend();
  win.__mockAutoSync = FAST;
  win.__mockSetPull?.({ conflicted: false, changed: [] });
  win.__mockSetPrivacy?.(null);
  await stageSettings("true");

  // No remote: the lane boots with the gate shut, and start()'s open pull is
  // refused by it. Nothing has synced when the render settles.
  const r = await renderComponent(t, h(await bootComponent(), { autoSync: true }));
  await r.settle();
  assert.deepEqual(win.__mockSyncCalls?.() ?? [], [], "an unconfigured vault synced");

  // …and now the user enrolls, from this same running app.
  const before = (win.__mockSyncCalls?.() ?? []).length;
  await saveRemote();
  await afterTheDebounce(r.settle);
  assert.deepEqual(
    (win.__mockSyncCalls?.() ?? []).slice(before),
    [],
    "the save pulled on its own — the first pull after enrollment is the pane's button"
  );

  // The lane is live in place: an edit settles into a push, no remount.
  await editTheVault("arming");
  await afterTheDebounce(r.settle);
  assert.deepEqual(
    (win.__mockSyncCalls?.() ?? []).slice(before),
    ["vault_sync_push"],
    "the settle-push stayed dead after the remote landed"
  );
});

test("a vault that parked the lane stays parked through a save", async (t) => {
  const win: MockWindow = await mockBackend();
  win.__mockAutoSync = FAST;
  win.__mockSetPull?.({ conflicted: false, changed: [] });
  await stageSettings("false");

  const r = await renderComponent(t, h(await bootComponent(), { autoSync: true }));
  await r.settle();
  const before = (win.__mockSyncCalls?.() ?? []).length;

  // Saving a remote reopens the `configured` gate and nothing else — the
  // Settings.md answer is a separate gate, and it is shut.
  await saveRemote();
  await editTheVault("parked");
  await afterTheDebounce(r.settle);

  const fired = (win.__mockSyncCalls?.() ?? []).slice(before);
  assert.deepEqual(fired, [], `the parked lane synced after a save: ${fired.join(", ")}`);
});
