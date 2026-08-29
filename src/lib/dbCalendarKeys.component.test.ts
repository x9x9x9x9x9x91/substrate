/** Arrow keys in the database pane's calendar layout, rendered for real
    through the component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    A month grid draws no `[data-fc][data-fr]` cell, so the pane's (column,
    row) walk has nothing to land on there. When the walk still ran, ↓↓Enter
    opened the third row in sort order with nothing on screen to say which one
    it was — and the arrows were preventDefaulted on the way, so the grid could
    not be scrolled by keyboard either. The calendar leaves both alone: Tab
    reaches every chip and Enter activates it. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Release";

const SCHEMA = {
  released: { kind: "date" },
  status: { options: [{ value: "live" }] },
} as unknown as Record<string, PropSchema>;

/** three rows on three days of the same month — the grid the walk used to
    traverse invisibly */
function row(title: string, day: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: DB, released: day, status: "live" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [row("Aster", "2026-07-03"), row("Bittern", "2026-07-10"), row("Coriander", "2026-07-17")];

function paneProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: DB,
    notes: NOTES,
    allNotes: NOTES,
    pref: { view: "calendar" },
    typeSchema: SCHEMA,
    schema: { [DB]: SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: [DB],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    onPrefChange: () => {},
    onOpenNote: () => {},
    onNoteMenu: () => {},
    onTrashNotes: () => {},
    onMutated: () => {},
    onSaveView: () => {},
    savedViews: [],
    pinKeys: {},
    onOpenView: () => {},
    onViewMenu: () => {},
    onRenameDb: () => {},
    onDeleteDb: () => {},
    onRenameProp: () => {},
    onRemoveProp: () => {},
    ...over,
  };
}

type Pane = Awaited<ReturnType<typeof renderComponent>>;

async function mountPane(
  t: Parameters<typeof renderComponent>[0],
  over: Record<string, unknown> = {}
): Promise<Pane> {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return renderComponent(t, h(DatabasePane as never, paneProps(over) as never));
}

/** the pane's keyboard surface is bound to the window, the way App hands it
    over; the return says whether the pane claimed the key */
async function pressWindow(key: string): Promise<boolean> {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    window.dispatchEvent(e);
  });
  return e.defaultPrevented;
}

test("the calendar draws a month, not rows the walk could land on", async (t) => {
  const r = await mountPane(t);
  assert.ok(r.one(".cal-grid.month"), "the month grid is on screen");
  assert.equal(r.all("[data-fc][data-fr]").length, 0, "no cell coordinates to walk");
});

test("arrows are left to the pane, not swallowed by an invisible focus walk", async (t) => {
  const r = await mountPane(t);
  assert.equal(await pressWindow("ArrowDown"), false, "↓ stays available to scroll");
  await r.settle();
  assert.equal(await pressWindow("ArrowUp"), false, "↑ stays available to scroll");
  assert.equal(await pressWindow("ArrowRight"), false, "→ too");
  assert.equal(r.one(".focused"), null, "and nothing anywhere took a focus ring");
});

test("Enter after arrows opens nothing — there was never a focused row", async (t) => {
  const opened: string[] = [];
  const r = await mountPane(t, { onOpenNote: (p: string) => opened.push(p) });
  await pressWindow("ArrowDown");
  await pressWindow("ArrowDown");
  await r.settle();
  assert.equal(await pressWindow("Enter"), false, "Enter is not claimed either");
  await r.settle();
  assert.deepEqual(opened, [], "no note opened behind the reader's back");
});
