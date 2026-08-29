/** The Sync pane's list of files a pull left out because the transport cannot
    carry them, rendered for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A refusal rides a pull that otherwise worked, which is exactly why it needs
    a surface of its own: the counts read as a success, and without the list
    the user's evidence that a file is not syncing is that the other device
    never shows it. The engine sends the names typed (`SyncReport.refused`)
    alongside the prose, so the pane can name each one instead of asking the
    user to read paths out of a sentence. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

async function configured(win: MockWindow) {
  const { vaultSyncSetRemote } = await import("./ipc.ts");
  const { resetSyncConfigured } = await import("./embedstate.ts");
  await vaultSyncSetRemote("file:///tmp/vault-test-sync.git", "");
  resetSyncConfigured();
  assert.equal(
    typeof win.__mockSetSyncRefused,
    "function",
    "the mock backend installed no __mockSetSyncRefused — this test would assert " +
      "against a pane that was never given a refusal"
  );
}

test("a pull that left a file out names it, on a pull that otherwise worked", async (t) => {
  const win = await mockBackend();
  await configured(win);
  // a pull that lands cleanly: the refusal is the only thing wrong with it
  win.__mockSetPull?.({ conflicted: false, changed: ["note.md"] });
  win.__mockSetSyncRefused?.({
    oversize: [{ path: "Music/take.wav", size: 67108865 }],
    unreadable: ["Music/broken.wav"],
  });
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const pull = r.all(".vault-sync-button").find((b) => b.textContent === "Pull");
  assert.ok(pull, "no Pull button to press");
  await r.click(pull);
  await r.settle();

  const refused = r.one(".vault-sync-refused");
  assert.ok(refused, "the pane swallowed the files sync would not carry");
  // both kinds of refusal are named — an unreadable file is just as absent
  // from the other device as an oversize one
  assert.match(refused.textContent ?? "", /Music\/take\.wav/);
  assert.match(refused.textContent ?? "", /Music\/broken\.wav/);
  // and the prose still explains why, so the list is not a bare set of paths
  assert.ok(r.one(".vault-sync-notice"), "the refusal lost the sentence that explains it");
});

test("a pull that carries everything shows no list", async (t) => {
  const win = await mockBackend();
  await configured(win);
  win.__mockSetPull?.({ conflicted: false, changed: [] });
  win.__mockSetSyncRefused?.(null);
  const { default: VaultSyncPane } = await import("../components/VaultSyncPane.tsx");
  const r = await renderComponent(t, h(VaultSyncPane, { autoSync: false }));

  const pull = r.all(".vault-sync-button").find((b) => b.textContent === "Pull");
  assert.ok(pull, "no Pull button to press");
  await r.click(pull);
  await r.settle();

  assert.equal(r.one(".vault-sync-refused"), null, "an ordinary pull grew a refusal list");
});
