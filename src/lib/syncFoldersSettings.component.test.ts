/** The no-sync folders panel rendered for real over the mock backend
    (`componentHarness.ts`; the pattern is written up in
    `docs/component-tests.md`).

    Two behaviours are worth a real render rather than a unit test of the
    helpers. The switch's SENSE is inverted against the underlying flag — it
    reads "does this folder sync?", while the engine stores "is it excluded?" —
    and getting that backwards would ship a panel that turns sync off when
    someone turns it on. And the refusal is the one path where a click changes
    nothing and the panel has to say why, naming the files, which is a render
    and not a return value. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";

async function panel(t: Parameters<typeof renderComponent>[0], toasts: string[] = []) {
  await mockBackend();
  const { default: SyncFoldersSettings } = await import(
    "../components/SyncFoldersSettings.tsx"
  );
  return renderComponent(
    t,
    h(SyncFoldersSettings, { onToast: (msg: string) => void toasts.push(msg) })
  );
}

test("the switch reads as syncing, not as excluded", async (t) => {
  const view = await panel(t);
  const files = view.one('[data-testid="sync-folder-Files"]');
  const notes = view.one('[data-testid="sync-folder-Notes"]');
  assert.ok(files && notes, "both folders are listed");
  // `Files` ships excluded, `Notes` syncs — the switch says so in the reader's
  // terms, and its aria state is what a screen reader and the e2e tier read
  assert.equal(files.getAttribute("aria-checked"), "false");
  assert.equal(notes.getAttribute("aria-checked"), "true");
  assert.match(
    view.one('[data-testid="sync-folder-state-Files"]')?.textContent ?? "",
    /Stays on this device/
  );
  assert.match(
    view.one('[data-testid="sync-folder-state-Notes"]')?.textContent ?? "",
    /Syncs to your other devices/
  );
});

test("a folder goes off sync and comes back, quietly both ways", async (t) => {
  const toasts: string[] = [];
  const view = await panel(t, toasts);
  const notes = () => view.one('[data-testid="sync-folder-Notes"]');
  const state = () => view.one('[data-testid="sync-folder-state-Notes"]')?.textContent ?? "";
  const syncing = notes()?.getAttribute("aria-checked") === "true";

  await view.click('[data-testid="sync-folder-Notes"]');
  assert.equal(notes()?.getAttribute("aria-checked"), syncing ? "false" : "true");
  await view.click('[data-testid="sync-folder-Notes"]');
  assert.equal(notes()?.getAttribute("aria-checked"), syncing ? "true" : "false");
  assert.match(state(), syncing ? /Syncs to your other devices/ : /Stays on this device/);
  // a small folder coming back into sync is not worth a sentence; the warning
  // is reserved for an include big enough to change what the next sync costs
  assert.deepEqual(toasts, []);
});

test("a folder too heavy to sync is refused, with the files named", async (t) => {
  const view = await panel(t);
  // `Samples` holds a file past the transport's per-object ceiling
  await view.click('[data-testid="sync-folder-Samples"]');
  const refusal = view.one('[data-testid="sync-folder-refusal"]');
  assert.ok(refusal, "the panel says why nothing happened");
  assert.match(refusal.textContent ?? "", /Samples\/orchestra\.wav/);
  assert.match(refusal.textContent ?? "", /64 MB/, "and names the ceiling");
  assert.equal(
    view.one('[data-testid="sync-folder-Samples"]')?.getAttribute("aria-checked"),
    "false",
    "the switch stays where it was — nothing was applied"
  );
});
