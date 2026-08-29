/** `useVaultIndex`'s refresh, run for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A refresh patches the note list from the paths a write named instead of
    re-listing the whole vault, and the two ways that can go wrong are only
    visible with the hook actually running: a refresh whose reach the ledger
    never covered, which would patch the wrong handful of rows and lose the
    notes the command really added; and a refresh whose fetches all fail,
    which drained the ledger and would otherwise leave those rows stale until
    something unrelated re-listed. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { SETTINGS_PATH } from "./settings.ts";
import type { NoteMeta } from "./types.ts";

type Index = {
  notes: NoteMeta[];
  refresh: (ownWrite?: boolean, paths?: string[] | null) => Promise<void>;
};

/** The hook alone, with a handle on what it is holding. */
async function bootIndex() {
  const { useVaultIndex } = await import("../hooks/useVaultIndex.ts");
  const live: { current: Index | null } = { current: null };
  const Boot = () => {
    live.current = useVaultIndex() as unknown as Index;
    return h("div", null, String(live.current.notes.length));
  };
  return { Boot, live };
}

/** Drive a refresh the way the app does — from an event handler, with the
    render it causes flushed before anything is asserted. */
async function refreshed(live: { current: Index | null }, settle: () => Promise<void>) {
  await act(async () => {
    await live.current?.refresh();
  });
  await settle();
}

const paths = (live: { current: Index | null }) => (live.current?.notes ?? []).map((n) => n.path);

test("a refresh no write named still shows the notes that command created", async (t) => {
  const win: MockWindow = await mockBackend();
  win.__mockFail?.clear();
  const { vaultSetProp } = await import("./ipc.ts");
  const { __resetOwnWrites } = await import("./ownwrites.ts");
  const { Boot, live } = await bootIndex();

  const r = await renderComponent(t, h(Boot));
  __resetOwnWrites();
  // the first fill is always the whole vault
  await refreshed(live, r.settle);
  const before = paths(live);
  assert.ok(before.length > 0, "the list never filled");

  // A writer that patches its own surface and waits for the epoch — the
  // Settings sheet is the live one — leaves its path in the ledger, unspent.
  await vaultSetProp(SETTINGS_PATH, "mood", "warm");

  // …and now a command whose echo the watcher never attributes to us adds
  // notes. Its refresh names nothing, so the only thing standing between the
  // list and the new notes is the ledger having heard about the install.
  const { cookbookInstall } = await import("./ipc.ts");
  const installed = await cookbookInstall("food-log", ["Patch Recipe.md"]);
  const written = installed.files.map((f) => f.path);
  assert.ok(written.length > 0, "the install wrote nothing");

  await refreshed(live, r.settle);
  for (const path of written) {
    assert.ok(paths(live).includes(path), `the list never learned about ${path}`);
  }
});

test("a refresh whose patch and fallback both fail owes the list its paths again", async (t) => {
  const win: MockWindow = await mockBackend();
  win.__mockFail?.clear();
  const { vaultSetProp, vaultCreate } = await import("./ipc.ts");
  const { __resetOwnWrites, takeUnsyncedWrites } = await import("./ownwrites.ts");
  const { Boot, live } = await bootIndex();

  const r = await renderComponent(t, h(Boot));
  __resetOwnWrites();
  await refreshed(live, r.settle);

  const note = await vaultCreate("Double Failure", "");
  await refreshed(live, r.settle);
  assert.ok(paths(live).includes(note.path));

  // both reads down — the patch rejects, and so does the whole-list fallback
  // behind it. The refresh drained the ledger on its way in.
  win.__mockFail = new Set(["vault_metas", "vault_list"]);
  await vaultSetProp(note.path, "mood", "cool");
  await refreshed(live, r.settle);
  win.__mockFail.clear();

  const owed = takeUnsyncedWrites();
  assert.ok(
    owed.paths.includes(note.path),
    "the path was drained and never fetched — its row would stay stale forever"
  );
});
