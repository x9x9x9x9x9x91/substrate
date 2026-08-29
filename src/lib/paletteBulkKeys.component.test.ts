/** ⌘K → the selection's actions → the picker → a committed value, by keys.

    The palette is the keyboard route to the app, so a bulk action it offers
    has to be finishable without a mouse. The first cut wasn't: the palette
    closed, the pane opened its column picker, and the picker took no focus
    and answered no key but Escape — the row was reachable and the value was
    not. This drives the whole gesture with keydowns only, across BOTH
    surfaces at once (the pane holding the selection and the palette reading
    it), because that seam is exactly where the focus was being dropped.

    `paletteBulk.component.test.ts` pins what the palette draws and where its
    highlight starts; `dbBulkRegistry.component.test.ts` pins the write path
    under the handlers. Harness: `docs/component-tests.md`. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act as reactAct, createElement as h, Fragment } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { resetBulkSelectionForTests } from "./bulkactions.ts";
import { UndoContext } from "./undoContext.ts";
import type { UndoEntry } from "./undo.ts";
import type { NoteMeta, PropSchema, View } from "./types.ts";

const DB = "Task";
const SCHEMA = { Done: { kind: "checkbox" } } as unknown as Record<string, PropSchema>;

const { vaultCreate, vaultRead } = await import("./ipc.ts");

const act = reactAct as unknown as (scope: () => Promise<void>) => Promise<void>;

before(async () => {
  await mockBackend();
});

/** loose on purpose, like the other pane harnesses: naming all thirty
    callbacks would pin the prop list rather than the behaviour */
function paneProps(notes: NoteMeta[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: DB,
    notes,
    allNotes: notes,
    pref: { view: "table", cols: ["Done"] },
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

function paletteProps(notes: NoteMeta[], over: Record<string, unknown> = {}) {
  return {
    mode: "palette" as const,
    notes,
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

/** the table and the palette in one tree — the app's own arrangement, and
    the only way to drive the handoff between them */
async function mountBoth(
  t: Parameters<typeof renderComponent>[0],
  notes: NoteMeta[],
  recorded: Omit<UndoEntry, "id">[],
  over: { pane?: Record<string, unknown>; palette?: Record<string, unknown> } = {}
) {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const { default: Palette } = await import("../components/Palette.tsx");
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  return renderComponent(
    t,
    h(
      UndoContext.Provider,
      { value: { record: (e: Omit<UndoEntry, "id">) => recorded.push(e), runById: () => {}, evictScope: () => {} } },
      h(
        Fragment,
        null,
        h(DatabasePane as never, paneProps(notes, over.pane) as never),
        h(Palette as never, paletteProps(notes, over.palette) as never)
      )
    )
  );
}

/** the pane's selection gesture is a modified click — the only mouse in
    this file, and the gesture the keyboard route starts from */
async function selectRows(r: { all(s: string): Element[]; settle(): Promise<void> }, n: number) {
  const cells = r.all("td.db-title");
  for (let i = 0; i < n; i++) {
    await act(async () => {
      cells[i].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
      );
    });
  }
  await r.settle();
}

async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

/** whatever the keyboard is pointed at right now, by label — ColMenu
    portals to document.body, outside the harness's host */
function focusedLabel(): string {
  return document.activeElement?.textContent?.trim() ?? "";
}

function menuLabels(): string[] {
  return [...document.querySelectorAll(".colmenu .dots-item")].map(
    (el) => el.textContent?.trim() ?? ""
  );
}

test("⌘K to a committed value on the selection, without a mouse", async (t) => {
  const a = await vaultCreate("Keys Bulk A", "", DB, [], "");
  const b = await vaultCreate("Keys Bulk B", "", DB, [], "");
  const recorded: Omit<UndoEntry, "id">[] = [];
  const toasts: string[] = [];
  const r = await mountBoth(t, [a, b], recorded, { pane: { onToast: (m: string) => toasts.push(m) } });

  await selectRows(r, 2);
  const input = r.one("input.palette-input") ?? r.all("input")[r.all("input").length - 1];
  assert.ok(input, "the palette rendered no input to type into");

  // ↑ off the default recent row, into the selection's actions, and up to
  // the top of them — the reader's own three keys
  await key(input, "ArrowUp");
  await key(input, "ArrowUp");
  await key(input, "ArrowUp");
  await r.settle();
  assert.equal(
    r.one(".palette-item.selected .palette-item-label")?.textContent?.trim(),
    "Set property…"
  );

  await key(input, "Enter");
  await r.settle();

  // the picker opened AND took the focus — this is the step that used to
  // strand a keyboard reader on a menu no key could reach
  assert.deepEqual(menuLabels(), ["Created", "Done"], "the column picker did not open");
  assert.equal(focusedLabel(), "Created", "the picker opened without taking focus");

  // ↓ to the column being set, exactly as a mouse would have pointed at it
  await key(document.activeElement!, "ArrowDown");
  assert.equal(focusedLabel(), "Done", "↓ did not walk the column picker");

  await key(document.activeElement!, "Enter");
  await r.settle();
  // a checkbox column asks for the value in a second menu of the same kind
  assert.deepEqual(menuLabels(), ["Checked", "Unchecked"]);
  assert.equal(focusedLabel(), "Checked");

  await key(document.activeElement!, "ArrowDown");
  assert.equal(focusedLabel(), "Unchecked", "↓ did not walk the picker");
  await key(document.activeElement!, "ArrowUp");
  assert.equal(focusedLabel(), "Checked");

  await key(document.activeElement!, "Enter");
  await r.settle();

  // …and the value is committed, on the pane's own undoable bulk path
  assert.equal((await vaultRead(a.path)).props.Done, true);
  assert.equal((await vaultRead(b.path)).props.Done, true);
  assert.equal(recorded.length, 1, "the keyboard route wrote outside the one undo entry");
  assert.deepEqual(recorded[0].paths, [a.path, b.path]);
  assert.deepEqual(toasts, ["Set Done on 2 notes"]);
});

test("Escape still backs out of a picker the keyboard opened", async (t) => {
  const a = await vaultCreate("Keys Esc A", "", DB, [], "");
  const r = await mountBoth(t, [a], []);

  await selectRows(r, 1);
  const input = r.one("input.palette-input") ?? r.all("input")[r.all("input").length - 1];
  await key(input, "ArrowUp");
  await key(input, "ArrowUp");
  await key(input, "ArrowUp");
  await key(input, "Enter");
  await r.settle();
  assert.ok(menuLabels().includes("Done"), "the column picker did not open");

  await key(document.activeElement!, "Escape");
  await r.settle();
  assert.deepEqual(menuLabels(), [], "Escape left the picker open");
});

test("Move to Trash and Clear selection finish on Enter alone", async (t) => {
  const a = await vaultCreate("Keys Trash A", "", DB, [], "");
  const b = await vaultCreate("Keys Trash B", "", DB, [], "");
  const trashed: string[][] = [];
  const r = await mountBoth(t, [a, b], [], {
    pane: { onTrashNotes: (p: string[]) => trashed.push(p) },
  });

  await selectRows(r, 2);
  const input = r.one("input.palette-input") ?? r.all("input")[r.all("input").length - 1];

  // one ↑ lands on the last action in the section — the destructive one
  await key(input, "ArrowUp");
  await r.settle();
  assert.equal(
    r.one(".palette-item.selected .palette-item-label")?.textContent?.trim(),
    "Move to Trash"
  );
  await key(input, "Enter");
  await r.settle();
  assert.deepEqual(trashed, [[a.path, b.path]]);
  assert.equal(r.all("tr.selected").length, 0, "the trashed rows are still selected");

  // and the same route clears a selection instead
  await selectRows(r, 2);
  await key(input, "ArrowUp");
  await key(input, "ArrowUp");
  await r.settle();
  assert.equal(
    r.one(".palette-item.selected .palette-item-label")?.textContent?.trim(),
    "Clear selection"
  );
  await key(input, "Enter");
  await r.settle();
  assert.equal(r.all("tr.selected").length, 0, "Enter on Clear selection kept the selection");
  assert.deepEqual(trashed.length, 1, "clearing trashed something");
});
