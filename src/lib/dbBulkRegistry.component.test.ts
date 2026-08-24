/** The table's bulk actions, from both doors.

    The bulk bar under a selection and the ⌘K palette draw ONE list of
    actions (`bulkactions.ts`) — the bar renders it as its buttons, and the
    pane publishes the same handlers into the shared slot the palette reads.
    What has to hold, and what tsc can't see:

      1. the bar's buttons ARE the registry's entries, in its order — no
         second definition of "Move to Trash" living in the layout;
      2. the handlers the palette gets are the pane's own, so a property set
         from the palette walks the pane's bulk write: one undo entry across
         every note that took the write, and "didn't save" marks on the ones
         that refused;
      3. the slot is claimed only while a selection is live, which is what
         keeps the palette's bulk section out of an unselected table.

    Harness written up in `docs/component-tests.md`. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { getBulkSelection, resetBulkSelectionForTests } from "./bulkactions.ts";
import { UndoContext } from "./undoContext.ts";
import type { UndoEntry } from "./undo.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Task";

const SCHEMA = {
  Done: { kind: "checkbox" },
} as unknown as Record<string, PropSchema>;

const { vaultCreate, vaultRead } = await import("./ipc.ts");

before(async () => {
  await mockBackend();
});

function meta(path: string, title: string): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: "",
    props: { type: DB },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

/** Every prop the pane needs, with everything these tests don't drive inert
    — built loosely on purpose, the way the other pane harnesses are: naming
    all thirty callbacks would pin the prop list rather than the behaviour. */
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

/** the pane under a recorder, so a bulk write's undo entry is inspectable */
async function mountPane(
  t: Parameters<typeof renderComponent>[0],
  notes: NoteMeta[],
  recorded: Omit<UndoEntry, "id">[],
  over: Record<string, unknown> = {}
) {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  resetBulkSelectionForTests();
  t.after(resetBulkSelectionForTests);
  return renderComponent(
    t,
    h(
      UndoContext.Provider,
      { value: { record: (e: Omit<UndoEntry, "id">) => recorded.push(e), runById: () => {} } },
      h(DatabasePane as never, paneProps(notes, over) as never)
    )
  );
}

/** the harness's own click carries no modifier — a modified one is the
    pane's selection gesture */
async function mouse(el: Element, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

async function selectRows(r: { all(s: string): Element[]; settle(): Promise<void> }, n: number) {
  const cells = r.all("td.db-title");
  for (let i = 0; i < n; i++) await mouse(cells[i], { metaKey: true });
  await r.settle();
}

/** ColMenu portals to document.body, outside the harness's host */
function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll(".colmenu .dots-item")].find(
    (el) => el.textContent?.trim() === label
  );
  assert.ok(
    found,
    `no “${label}” in the open menu: ${[...document.querySelectorAll(".colmenu")].map((m) => m.textContent).join(" | ")}`
  );
  return found as HTMLElement;
}

test("the bulk bar's buttons are the registry's entries, in its order", async (t) => {
  const a = await vaultCreate("Bulk Bar A", "", DB, [], "");
  const b = await vaultCreate("Bulk Bar B", "", DB, [], "");
  const r = await mountPane(t, [a, b], []);

  await selectRows(r, 2);

  assert.deepEqual(
    r.all(".bulkbar button").map((el) => el.textContent?.trim() || el.getAttribute("aria-label")),
    ["Set property…", "Move to Trash", "Clear selection"],
    "the bar drew something other than the shared list"
  );
  // and the same list, live, for whoever else wants to draw it
  assert.deepEqual(
    (getBulkSelection()?.count ?? 0),
    2,
    "the pane published no selection for the palette to read"
  );
});

test("no selection, no published slot", async (t) => {
  const a = await vaultCreate("Bulk Slot A", "", DB, [], "");
  const r = await mountPane(t, [a], []);

  assert.equal(getBulkSelection(), null, "an empty table claimed the slot");
  await selectRows(r, 1);
  assert.ok(getBulkSelection(), "a live selection published nothing");

  await r.click(".bulkbar-x");
  assert.equal(getBulkSelection(), null, "clearing the selection left the slot claimed");
});

test("a property set from the palette's handler is the pane's own bulk write", async (t) => {
  const a = await vaultCreate("Bulk Write A", "", DB, [], "");
  const b = await vaultCreate("Bulk Write B", "", DB, [], "");
  const recorded: Omit<UndoEntry, "id">[] = [];
  const toasts: string[] = [];
  const r = await mountPane(t, [a, b], recorded, { onToast: (m: string) => toasts.push(m) });

  await selectRows(r, 2);

  // the palette's row, not the bar's button
  await act(async () => {
    getBulkSelection()!.setProperty!();
  });
  await r.settle();
  await mouse(menuItem("Done"));
  await r.settle();
  await mouse(menuItem("Checked"));
  await r.settle();

  assert.equal((await vaultRead(a.path)).props.Done, true);
  assert.equal((await vaultRead(b.path)).props.Done, true);
  assert.equal(recorded.length, 1, "two writes, and not one undoable action");
  assert.deepEqual(recorded[0].paths, [a.path, b.path]);
  assert.deepEqual(toasts, ["Set Done on 2 notes"]);

  // and taking it back takes back both
  await act(async () => {
    await recorded[0].undo();
  });
  assert.ok(!(await vaultRead(a.path)).props.Done);
  assert.ok(!(await vaultRead(b.path)).props.Done);
});

test("a refused row comes back marked, whichever door asked", async (t) => {
  const a = await vaultCreate("Bulk Fail A", "", DB, [], "");
  // never created: the engine refuses the write, the way a note deleted
  // under a stale table does
  const gone = meta("Bulk Fail Gone.md", "Bulk Fail Gone");
  const recorded: Omit<UndoEntry, "id">[] = [];
  const r = await mountPane(t, [a, gone], recorded);

  await selectRows(r, 2);
  await act(async () => {
    getBulkSelection()!.setProperty!();
  });
  await r.settle();
  await mouse(menuItem("Done"));
  await r.settle();
  await mouse(menuItem("Checked"));
  await r.settle();

  assert.equal(recorded.length, 1, "the write that landed is still takeable back");
  assert.deepEqual(recorded[0].paths, [a.path], "the refused note is not in the undo");
  // the refused note IS the selection now, and the bar says so
  assert.match(r.text(), /1 didn’t save/);
  assert.equal(r.all("tr.is-selected").length, 1, "the refused row is not the new selection");
});

test("Move to Trash from the palette's handler trashes the selection and clears it", async (t) => {
  const a = await vaultCreate("Bulk Trash A", "", DB, [], "");
  const b = await vaultCreate("Bulk Trash B", "", DB, [], "");
  const trashed: string[][] = [];
  const r = await mountPane(t, [a, b], [], { onTrashNotes: (p: string[]) => trashed.push(p) });

  await selectRows(r, 2);
  await act(async () => {
    getBulkSelection()!.trash!();
  });
  await r.settle();

  assert.deepEqual(trashed, [[a.path, b.path]]);
  assert.equal(getBulkSelection(), null, "the selection survived its own trashing");
});
