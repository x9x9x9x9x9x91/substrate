/** The Sync pane's sticky privacy notice, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    The bug this pins is a timing one, so neither `tsc` nor a status snapshot
    can see it: a failed sealing cleanup leaves plaintext in this device's git
    history and says so on the pane — and then the auto lane pulls again a few
    minutes later, the pull succeeds, and the pane's one error slot is taken
    back by the success. The warning disappears while the plaintext it warns
    about is still there.

    So the notice rides its own field, and the two assertions that matter are:
    a later successful pull does NOT take it down, and an explicit dismissal
    does. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

const MESSAGE =
  "sync landed, but inherited sealing could not remove its plaintext local history: disk full";
const LEAKED = "Sealed/Private note.md";

/** A configured remote, a pull that will succeed, and the notice an earlier
    failed cleanup left behind. */
async function stage(win: MockWindow) {
  const { vaultSyncSetRemote } = await import("./ipc.ts");
  const { resetSyncConfigured } = await import("./embedstate.ts");
  await vaultSyncSetRemote("file:///tmp/vault-test-sync.git", "");
  resetSyncConfigured();
  win.__mockSetPull?.({ conflicted: false, changed: [] });
  assert.equal(
    typeof win.__mockSetPrivacy,
    "function",
    "the mock backend installed no __mockSetPrivacy — this test would assert " +
      "against a pane that was never given a notice"
  );
  win.__mockSetPrivacy?.({ message: MESSAGE, paths: [LEAKED] });
}

test("a successful pull does not take the privacy notice down", async (t) => {
  const win = await mockBackend();
  await stage(win);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  assert.ok(r.one(".vault-sync-privacy"), "the pane never showed the warning");
  assert.match(r.text(), /plaintext local history/);
  // it names the file, so a user who wants to purge by hand knows where to look
  assert.match(r.text(), new RegExp(LEAKED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // and it reads as an outstanding problem, not as "the last sync failed"
  assert.match(r.text(), /Needs attention/);

  const pull = r.all(".vault-sync-button").find((b) => b.textContent === "Pull");
  assert.ok(pull, "no Pull button to press");
  await r.click(pull);
  await r.settle();

  assert.match(r.text(), /Pulled 0/, "the pull did not land");
  assert.ok(
    r.one(".vault-sync-privacy"),
    "a successful pull erased the plaintext warning — the plaintext is still in history"
  );
  assert.match(r.text(), /Needs attention/);
});

test("dismissing it is the thing that takes it down", async (t) => {
  const win = await mockBackend();
  await stage(win);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const dismiss = r.one(".vault-sync-privacy .vault-sync-button");
  assert.ok(dismiss, "the warning offered no way out");
  await r.click(dismiss);
  await r.settle();

  assert.equal(r.one(".vault-sync-privacy"), null, "dismissing left the warning up");
  assert.doesNotMatch(r.text(), /plaintext local history/);
  assert.match(r.text(), /Ready/, "the pane stayed alarmed after the warning was answered");
});
