/** What the Sync pane's status chip says while a push or a pull it started is
    still running, rendered for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    The state this pins is the retry. A failed leg is recorded — `last_error`
    outlives the attempt, by design, so a user who walked away still finds out
    it failed. But the chip is the headline, and it kept reading "Error" with
    the previous message for the whole of the next attempt: a push that ran for
    minutes was invisible, and pressing Push again looked like it had done
    nothing. So an in-flight leg speaks first, in the plain tone "Checking"
    uses — the previous attempt's red must not stand over a new one that has
    not answered yet. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow, Rendered } from "./componentHarness.ts";

async function configured(win: MockWindow) {
  const { vaultSyncSetRemote } = await import("./ipc.ts");
  const { resetSyncConfigured } = await import("./embedstate.ts");
  await vaultSyncSetRemote("file:///tmp/vault-test-sync.git", "");
  resetSyncConfigured();
  // The mock's default pull conflicts; nothing here is about conflicts, and a
  // conflicted merge would answer the chip before the in-flight state could.
  win.__mockSetPull?.({ conflicted: false });
  assert.equal(
    typeof win.__mockHoldCommand,
    "function",
    "the mock backend installed no __mockHoldCommand — this test cannot park a " +
      "push mid-flight and would assert against a leg that already landed"
  );
}

async function pane(t: Parameters<typeof renderComponent>[0]) {
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  return renderComponent(t, h(VaultSyncPane, { autoSync: false }));
}

function button(r: Rendered, label: string) {
  const el = r.all(".vault-sync-button").find((b) => b.textContent === label);
  assert.ok(el, `no ${label} button to press`);
  return el;
}

function chip(r: Rendered) {
  const el = r.one(".vault-sync-state");
  assert.ok(el, "the pane rendered no status chip");
  return el;
}

test("a retry after a failed push says it is pushing, not that it failed", async (t) => {
  const win = await mockBackend();
  await configured(win);
  const r = await pane(t);
  const push = button(r, "Push");

  // The failure the user is retrying from: recorded, and still recorded after
  // the pane re-reads the status — that is the point of the slot.
  win.__mockFailOnce?.("vault_sync_push");
  await r.click(push);
  await r.settle();
  assert.match(chip(r).textContent ?? "", /Error/);
  assert.match(r.text(), /mock failure: vault_sync_push/);

  // The retry, parked mid-flight. This is the whole defect: the chip used to
  // keep the previous message here, for as long as the new push ran.
  win.__mockHoldCommand?.("vault_sync_push");
  try {
    await r.click(push);
    await r.settle();
    assert.match(chip(r).textContent ?? "", /Pushing/);
    assert.doesNotMatch(chip(r).textContent ?? "", /Error/);
    assert.doesNotMatch(
      chip(r).className,
      /danger/,
      "the previous attempt's red stood over a push that had not answered yet"
    );
  } finally {
    win.__mockReleaseCommand?.("vault_sync_push");
  }

  // And when it lands, the old error is gone everywhere.
  await r.settle();
  assert.match(chip(r).textContent ?? "", /Ready/);
  assert.match(r.text(), /Pushed 2/);
  assert.doesNotMatch(r.text(), /mock failure/);
});

test("a pull in flight says so too", async (t) => {
  const win = await mockBackend();
  await configured(win);
  const r = await pane(t);

  win.__mockHoldCommand?.("vault_sync_pull");
  try {
    await r.click(button(r, "Pull"));
    await r.settle();
    assert.match(chip(r).textContent ?? "", /Pulling/);
  } finally {
    win.__mockReleaseCommand?.("vault_sync_pull");
  }
  await r.settle();
  assert.match(chip(r).textContent ?? "", /Ready/);
});

test("a retry that fails again shows the fresh error, not silence", async (t) => {
  const win = await mockBackend();
  await configured(win);
  const r = await pane(t);
  const push = button(r, "Push");

  win.__mockFailOnce?.("vault_sync_push");
  await r.click(push);
  await r.settle();
  assert.match(chip(r).textContent ?? "", /Error/);

  win.__mockFailOnce?.("vault_sync_push");
  await r.click(push);
  await r.settle();
  assert.match(chip(r).textContent ?? "", /Error/);
  assert.match(r.text(), /mock failure: vault_sync_push/);
  assert.match(chip(r).className, /danger/);
});

test("an idle configured vault is unchanged by any of this", async (t) => {
  const win = await mockBackend();
  await configured(win);
  const r = await pane(t);

  assert.match(chip(r).textContent ?? "", /Ready/);
  assert.match(chip(r).className, /ok/);
});
