/** The busy mark's accessible name, rendered for real through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    `.sync-spinner` REPLACES a button's label while the work runs — so for the
    length of a push the button had no accessible name at all and the spinner
    itself was an empty `<span>`: a reader on assistive tech pressed Push and
    was told nothing, then found a nameless button where the label had been.
    The mark now carries `role="status"` and a name, which both announces the
    work and gives the button its name back for as long as it stands in. */

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

test("the mark that replaces a button label announces itself and names the button", async (t) => {
  const win = await mockBackend();
  await configured(win);
  const r = await pane(t);
  const push = button(r, "Push");

  win.__mockHoldCommand?.("vault_sync_push");
  try {
    await r.click(push);
    await r.settle();

    const mark = r.one(".sync-spinner");
    assert.ok(mark, "the push in flight rendered no busy mark");
    assert.equal(mark.getAttribute("role"), "status");
    const name = mark.getAttribute("aria-label") ?? "";
    assert.notEqual(name.trim(), "", "the busy mark is still an unnamed span");

    // The button's own name comes from its contents, and the mark is all the
    // contents it has left — a nameless mark is a nameless button.
    const busy = r.all(".vault-sync-button").find((b) => b.querySelector(".sync-spinner"));
    assert.ok(busy, "no button is standing in a busy mark for its label");
    assert.equal((busy.textContent ?? "").trim(), "", "the label is meant to be gone while busy");
  } finally {
    win.__mockReleaseCommand?.("vault_sync_push");
  }

  await r.settle();
  assert.equal(r.one(".sync-spinner"), null, "the busy mark outlived the work it stood for");
});

test("no busy mark anywhere on the pane is left nameless", async (t) => {
  const win = await mockBackend();
  await configured(win);
  const r = await pane(t);

  win.__mockHoldCommand?.("vault_sync_pull");
  try {
    await r.click(button(r, "Pull"));
    await r.settle();
    for (const mark of r.all(".sync-spinner")) {
      const named =
        (mark.getAttribute("aria-label") ?? "").trim() !== "" ||
        mark.getAttribute("aria-hidden") === "true";
      assert.ok(named, "a busy mark reaches assistive tech as an empty span");
    }
  } finally {
    win.__mockReleaseCommand?.("vault_sync_pull");
  }
});
