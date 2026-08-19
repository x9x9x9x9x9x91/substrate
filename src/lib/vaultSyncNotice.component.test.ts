/** The Sync pane's warning for a hosted store approaching the number of
    encrypted objects one sync can work through, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    What this pins is the difference between a warning and a failure. The store
    filling up is a one-way number: past the ceiling, syncing stops, and the
    way out — rebuilding the hosted store from the vault's current state — is
    attended work nobody should first hear about from a push that already
    failed. So it rides the successful result, and the pane has to show it
    while still reading as a vault that is fine. A warning that turned the
    pane red would be doing the opposite job.

    The other half is that it has to survive. Auto-sync is on by default and
    pulls every few minutes; a warning riding the last sync result is painted
    over by the next pull, which is how this one was invisible in practice. So
    the backend keeps it in its own slot and only a push can take it back. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

const NOTICE =
  "Hosted sync is holding 80000 encrypted objects, out of the 100000 one sync can work " +
  "through. Syncing still works. Before the limit is reached, this vault will need a hosted " +
  "store rebuilt from its current state.";

async function configured(win: MockWindow) {
  const { vaultSyncSetRemote } = await import("./ipc.ts");
  const { resetSyncConfigured } = await import("./embedstate.ts");
  await vaultSyncSetRemote("file:///tmp/vault-test-sync.git", "");
  resetSyncConfigured();
  assert.equal(
    typeof win.__mockSetSyncNotice,
    "function",
    "the mock backend installed no __mockSetSyncNotice — this test would assert " +
      "against a pane that was never given a notice"
  );
}

test("a push that warns about the store filling up shows it without reading as a failure", async (t) => {
  const win = await mockBackend();
  await configured(win);
  win.__mockSetSyncNotice?.(NOTICE);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const push = r.all(".vault-sync-button").find((b) => b.textContent === "Push");
  assert.ok(push, "no Push button to press");
  await r.click(push);
  await r.settle();

  assert.ok(r.one(".vault-sync-notice"), "the pane swallowed the warning");
  assert.match(r.text(), /Before the limit is reached/);
  // the push landed, and the pane says so rather than raising an alarm
  assert.match(r.text(), /Pushed 2/);
  assert.match(r.text(), /Ready/);
  assert.doesNotMatch(r.text(), /Needs attention/);
  assert.equal(r.one(".vault-sync-error"), null, "the warning was rendered as an error");
});

test("a pull after the warning does not paint it away", async (t) => {
  const win = await mockBackend();
  await configured(win);
  win.__mockSetSyncNotice?.(NOTICE);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const push = r.all(".vault-sync-button").find((b) => b.textContent === "Push");
  assert.ok(push, "no Push button to press");
  await r.click(push);
  await r.settle();
  assert.ok(r.one(".vault-sync-notice"), "the push never showed the warning");

  // The auto lane's steady state: a pull that works. It says nothing about how
  // large the store is, so it may not answer the question either way.
  const pull = r.all(".vault-sync-button").find((b) => b.textContent === "Pull");
  assert.ok(pull, "no Pull button to press");
  await r.click(pull);
  await r.settle();
  assert.ok(r.one(".vault-sync-notice"), "a successful pull took the warning back");
  assert.match(r.text(), /Before the limit is reached/);

  // And it does go, when a push finds the store back under the threshold —
  // this is a warning with a way out, not a permanent fixture.
  win.__mockSetSyncNotice?.(null);
  await r.click(push);
  await r.settle();
  assert.equal(r.one(".vault-sync-notice"), null, "the warning outlived the condition");
});

test("pointing the vault at another remote leaves no warning about the old store", async (t) => {
  const win = await mockBackend();
  await configured(win);
  win.__mockSetSyncNotice?.(NOTICE);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const push = r.all(".vault-sync-button").find((b) => b.textContent === "Push");
  assert.ok(push, "no Push button to press");
  await r.click(push);
  await r.settle();
  assert.ok(r.one(".vault-sync-notice"), "the push never showed the warning");

  // Engine parity: `vault_sync_set_remote` replaces the whole sync record and
  // keeps only the privacy notice, because that one is about plaintext in THIS
  // machine's history. How full the OLD store was is not a fact about the new
  // one, and the next push against it works out its own answer.
  const { vaultSyncSetRemote } = await import("./ipc.ts");
  win.__mockSetSyncNotice?.(null);
  await vaultSyncSetRemote("file:///tmp/vault-test-sync-elsewhere.git", "");

  const pull = r.all(".vault-sync-button").find((b) => b.textContent === "Pull");
  assert.ok(pull, "no Pull button to press");
  await r.click(pull);
  await r.settle();
  assert.equal(
    r.one(".vault-sync-notice"),
    null,
    "the old store's size warning followed the vault to its new remote"
  );

  // The same parity on the hosted branch of set_remote — the one kind of
  // remote whose store can actually fill up, and so the re-point that matters.
  win.__mockSetSyncNotice?.(NOTICE);
  await r.click(push);
  await r.settle();
  assert.ok(r.one(".vault-sync-notice"), "the second push never showed the warning");
  win.__mockSetSyncNotice?.(null);
  await vaultSyncSetRemote(
    "blob+https://store.example.test/vault",
    "test-token",
    undefined,
    "a passphrase long enough",
  );
  await r.click(pull);
  await r.settle();
  assert.equal(
    r.one(".vault-sync-notice"),
    null,
    "the old store's size warning followed the vault to its new hosted remote"
  );
});

test("an ordinary push shows no notice at all", async (t) => {
  const win = await mockBackend();
  await configured(win);
  win.__mockSetSyncNotice?.(null);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const push = r.all(".vault-sync-button").find((b) => b.textContent === "Push");
  assert.ok(push, "no Push button to press");
  await r.click(push);
  await r.settle();

  assert.match(r.text(), /Pushed 2/);
  assert.equal(r.one(".vault-sync-notice"), null, "a quiet store still warned about its size");
});
