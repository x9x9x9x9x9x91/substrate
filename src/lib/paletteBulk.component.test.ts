/** ⌘K over a live table selection.

    The bulk bar under a table is the only place a multi-row selection could
    be acted on; the palette, which is the keyboard route to everything else,
    said nothing about one. These prove the palette now draws the selection's
    actions — the SAME descriptors the bar draws, from `bulkactions.ts` — and
    that it draws none of them when nothing is selected, so the section is an
    answer to a selection rather than dead furniture.

    `palette.component.test.ts` is the sibling that pins the destination
    catalogue; the harness is written up in `docs/component-tests.md`. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act as reactAct, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import {
  registerBulkSelection,
  resetBulkSelectionForTests,
  type BulkActionHandlers,
} from "./bulkactions.ts";
import type { NoteMeta, View } from "./types.ts";

/** React 19’s act, typed the way the harness types it */
const act = reactAct as unknown as (scope: () => Promise<void>) => Promise<void>;

before(async () => {
  await mockBackend();
});

function note(path: string, title: string): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: "",
    props: {},
    updated_ms: 0,
    excerpt: "",
    sealed: false,
    tags: [],
  };
}

function paletteProps(over: Record<string, unknown> = {}) {
  return {
    mode: "palette" as const,
    notes: [note("Field Notes.md", "Field Notes")],
    excludeAppFiles: false,
    databases: [],
    icons: {},
    dashboards: [],
    folders: [],
    savedViews: [],
    tagFolders: [],
    tags: [],
    proxyAvailable: false,
    current: null,
    templateTypes: [],
    onExportCsv: null,
    onPrint: null,
    onClose: () => {},
    onOpenNote: () => {},
    onSetView: (_v: View) => {},
    onOpenDb: () => {},
    onOpenJournal: () => {},
    onOpenTimeTravel: () => {},
    onOpenShortcuts: () => {},
    onAssignKeys: () => {},
    onCreate: () => {},
    onCreateFolder: () => {},
    onMoveNote: () => {},
    onRenameNote: () => {},
    onRenameFolder: () => {},
    onDuplicate: () => {},
    onShare: () => {},
    onTrashNote: () => {},
    onTogglePick: () => {},
    onTogglePin: () => {},
    pinnedPaths: [],
    onRevealRel: () => {},
    onCreateTyped: () => {},
    onEditTemplate: () => {},
    onNewDatabase: () => {},
    onCreateSheet: () => {},
    onCreateDashboard: () => {},
    onImportCsv: () => {},
    onSwitchCapture: () => {},
    onOpenSearch: () => {},
    onMutated: () => {},
    onToast: () => {},
    onToggleTerminal: null,
    onTerminalRun: null,
    terminalActions: [],
    onOpenSettings: () => {},
    ...over,
  };
}

async function openPalette(t: Parameters<typeof renderComponent>[0], over = {}) {
  const { default: Palette } = await import("../components/Palette.tsx");
  return renderComponent(t, h(Palette, paletteProps(over) as never));
}

function labels(r: { all(s: string): Element[] }): string[] {
  return r
    .all(".palette-item .palette-item-label")
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean);
}

function row(r: { all(s: string): Element[] }, label: string): Element | null {
  return (
    r
      .all(".palette-item")
      .find((el) => el.querySelector(".palette-item-label")?.textContent?.trim() === label) ?? null
  );
}

test("with rows selected, the palette leads with the selection's actions", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  registerBulkSelection({
    count: 3,
    setProperty: () => {},
    trash: () => {},
    clearSelection: () => {},
  });

  const r = await openPalette(t);

  // the bulk bar's three verbs, in the registry's order, ahead of everything
  assert.deepEqual(labels(r).slice(0, 3), [
    "Set property…",
    "Clear selection",
    "Move to Trash",
  ]);
  // labelled by how much is selected, so it is obviously about the table
  assert.ok(
    r.text().includes("3 selected"),
    `the bulk section is unlabelled: ${r.text().slice(0, 200)}`
  );
});

test("no selection, no bulk section", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);

  const r = await openPalette(t);

  for (const gone of ["Set property…", "Clear selection", "Move to Trash"]) {
    assert.equal(row(r, gone), null, `“${gone}” rendered with nothing selected`);
  }
  assert.ok(!r.text().includes("selected"), "an empty bulk section rendered anyway");
});

test("a bulk row runs the pane's own handler", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  const ran: string[] = [];
  const sel: BulkActionHandlers = {
    count: 2,
    setProperty: () => ran.push("prop"),
    trash: () => ran.push("trash"),
    clearSelection: () => ran.push("clear"),
  };
  registerBulkSelection(sel);

  const r = await openPalette(t);
  await r.click(row(r, "Move to Trash")!);

  // the pane's handler, not a second implementation living in the palette
  assert.deepEqual(ran, ["trash"]);
});

test("the palette's bulk rows follow the live selection away", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  const drop = registerBulkSelection({ count: 1, trash: () => {} });

  const r = await openPalette(t);
  assert.ok(row(r, "Move to Trash"), "no bulk row while a selection is live");

  // the pane unmounting, or the last row being deselected
  await act(async () => {
    drop();
  });
  await r.settle();

  assert.equal(row(r, "Move to Trash"), null, "the bulk row outlived the selection");
});

/** the palette's own key route: the input owns ↑/↓/Enter */
async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function selected(r: { one(s: string): Element | null }): string {
  return r.one(".palette-item.selected .palette-item-label")?.textContent?.trim() ?? "";
}

test("a live selection does not move the palette's default Enter", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  const ran: string[] = [];
  registerBulkSelection({
    count: 2,
    setProperty: () => ran.push("prop"),
    trash: () => ran.push("trash"),
    clearSelection: () => ran.push("clear"),
  });
  const opened: string[] = [];

  const r = await openPalette(t, { onOpenNote: (p: string) => opened.push(p) });

  // the actions render on top, the highlight stays on the first recent note
  assert.deepEqual(labels(r).slice(0, 3), ["Set property…", "Clear selection", "Move to Trash"]);
  assert.equal(selected(r), "Field Notes", "the selection stole the palette's default row");

  await key(r.one("input")!, "Enter");
  await r.settle();

  // ⌘K, Enter still means "open what I was just in"
  assert.deepEqual(opened, ["Field Notes.md"]);
  assert.deepEqual(ran, [], "bare Enter ran a bulk action");
});

test("one arrow-up from the default row reaches the selection's actions", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  const ran: string[] = [];
  registerBulkSelection({
    count: 2,
    setProperty: () => ran.push("prop"),
    trash: () => ran.push("trash"),
    clearSelection: () => ran.push("clear"),
  });
  const opened: string[] = [];

  const r = await openPalette(t, { onOpenNote: (p: string) => opened.push(p) });
  const input = r.one("input")!;

  await key(input, "ArrowUp");
  await r.settle();
  assert.equal(selected(r), "Move to Trash", "↑ did not land in the bulk section");

  await key(input, "Enter");
  await r.settle();
  assert.deepEqual(ran, ["trash"]);
  assert.deepEqual(opened, [], "the note under the default row opened anyway");
});

test("with nothing selected the default row is unchanged", async (t) => {
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  const opened: string[] = [];

  const r = await openPalette(t, { onOpenNote: (p: string) => opened.push(p) });
  assert.equal(selected(r), "Field Notes");

  await key(r.one("input")!, "Enter");
  await r.settle();
  assert.deepEqual(opened, ["Field Notes.md"]);
});
