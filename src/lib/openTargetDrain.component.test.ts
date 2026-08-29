/** The drain that collects destinations which arrived before App existed.

    A tray agenda click, an everywhere-palette row or a due-date notification
    during the launch scan has no listener to fire into — App does not mount
    while the boot frame is up. Rust queues those; this is the frontend half
    that collects them, and until now nothing exercised it: the mock always
    handed back an empty queue, so a drain that dropped everything would have
    passed. Each branch is asserted separately because each has its own
    payload shape and its own way of quietly opening nothing. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { SheetRowTarget } from "../hooks/useVaultEvents.ts";
import type { View } from "./types.ts";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
});

/** What the drain delivered, in arrival order. */
interface Drained {
  notes: string[];
  views: View[];
  sheets: SheetRowTarget[];
}

/** The smallest thing that owns the hook: App wires its openers into the refs
    the hook hands back, and this does the same with recorders. */
async function drainInto(t: Parameters<typeof renderComponent>[0]): Promise<Drained> {
  const { useVaultEvents } = await import("../hooks/useVaultEvents.ts");
  const got: Drained = { notes: [], views: [], sheets: [] };
  const Probe = () => {
    const { openNoteRef, openViewRef, openSheetRowRef } = useVaultEvents({
      refresh: () => {},
      refreshConfigs: () => {},
      refreshSealScopes: () => {},
      showToast: () => {},
      undoDispatch: () => {},
      setChangedPaths: () => {},
      setVaultEpoch: () => {},
      setBootFailed: () => {},
      lastOwnRefreshRef: { current: 0 },
    });
    // assigned in render, read by the hook's effects — which run after it
    openNoteRef.current = (path) => got.notes.push(path);
    openViewRef.current = (view) => got.views.push(view);
    openSheetRowRef.current = (target) => got.sheets.push(target);
    return null;
  };
  await renderComponent(t, h(Probe));
  return got;
}

test("a note queued before the window mounted still opens", async (t) => {
  win.__mockQueueOpenTarget({ note: "Inbox/queued.md", view: null, sheet: null });
  const got = await drainInto(t);
  assert.deepEqual(got.notes, ["Inbox/queued.md"], "the click must not be lost in silence");
});

test("a view queued before the window mounted still opens", async (t) => {
  // the palette's payload, checked rather than trusted: the drain looks the
  // destination up the same way the live `app:open-view` listener does
  win.__mockQueueOpenTarget({ note: null, view: { kind: "today" }, sheet: null });
  const got = await drainInto(t);
  assert.deepEqual(got.views, [{ kind: "today" }], "a queued destination is still a destination");
});

test("a payload no build has a case for opens nothing rather than an empty pane", async (t) => {
  win.__mockQueueOpenTarget({ note: null, view: { kind: "not-a-view" }, sheet: null });
  const got = await drainInto(t);
  assert.deepEqual(got.views, [], "an unparseable view is dropped, not rendered blank");
});

test("a sheet row queued before the window mounted still reveals its row", async (t) => {
  const target = { path: "Sheets/plan.md", column: "due", row: "Mix master" };
  win.__mockQueueOpenTarget({ note: null, view: null, sheet: target });
  const got = await drainInto(t);
  assert.deepEqual(got.sheets, [target], "a sheet cell's alert opens the note AND the row");
});

test("the queue is drained once: a second window finds it empty", async (t) => {
  win.__mockQueueOpenTarget({ note: "Inbox/once.md", view: null, sheet: null });
  const first = await drainInto(t);
  assert.deepEqual(first.notes, ["Inbox/once.md"]);
  const second = await drainInto(t);
  assert.deepEqual(second.notes, [], "a destination is opened once, not on every mount");
});
