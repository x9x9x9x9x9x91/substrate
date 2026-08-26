/** hjkl on a table cell that holds no editor, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    The table draws two kinds of cell: ones you type into, where h/j/k/l are
    the first letter of a value, and ones you cannot type into at all — a
    checkbox that toggles, a rollup the schema derives, a mounted folder's
    read-only Name. On the editor-less ones the letters have to keep their nav
    meaning, or the keystroke is swallowed for an edit that can never open and
    the row simply never moves. Editability was read off the column INDEX
    rather than its kind, so every data column counted as typeable and both
    kinds went dead — arrows still moved, hjkl did nothing at all. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Track";

/** Done toggles, Sessions is derived (declared without wiring, which reads
    as "no usable rollup" and still renders as one), Stage takes an editor. */
const SCHEMA = {
  Done: { kind: "checkbox" },
  Sessions: { kind: "rollup" },
  Stage: { options: [{ value: "live" }] },
} as unknown as Record<string, PropSchema>;

const COLS = ["Done", "Sessions", "Stage"];

function row(title: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: DB, Done: "true", Stage: "live" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [row("Aster"), row("Bittern"), row("Coriander")];

function paneProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: DB,
    notes: NOTES,
    allNotes: NOTES,
    pref: { view: "table", cols: COLS },
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

async function mountPane(t: Parameters<typeof renderComponent>[0]): Promise<Pane> {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return renderComponent(t, h(DatabasePane as never, paneProps() as never));
}

/** the column a header names, as a `data-fc` — the Name column is 0 */
function colOf(name: string): number {
  const i = COLS.indexOf(name);
  assert.ok(i >= 0, `no ${name} column`);
  return i + 1;
}

function cell(r: Pane, c: number, row: number): HTMLElement {
  const el = r.one(`td[data-fc="${c}"][data-fr="${row}"]`);
  assert.ok(el, `no cell at column ${c}, row ${row}`);
  return el as HTMLElement;
}

/** Focus the cell the way tabbing into it does — a click on a checkbox cell
    would toggle it, and on a text cell would open the editor. React listens
    for the bubbling `focusin`; jsdom's own constructors are not all installed
    as globals here, so a plain Event carries it. */
async function focusCell(r: Pane, c: number, row: number): Promise<void> {
  await act(async () => {
    cell(r, c, row).dispatchEvent(new Event("focusin", { bubbles: true }));
  });
  await r.settle();
}

/** the pane's keyboard surface is bound to the window, the way App hands it over */
async function pressWindow(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** where the focus ring is now, as [column, row] */
function focused(r: Pane): [number, number] | null {
  const el = r.one("td.db-cell.focused, td.db-title.focused");
  if (!el) return null;
  return [Number(el.getAttribute("data-fc")), Number(el.getAttribute("data-fr"))];
}

test("j and k move the row on a focused checkbox cell", async (t) => {
  const r = await mountPane(t);
  const c = colOf("Done");

  await focusCell(r, c, 0);
  assert.deepEqual(focused(r), [c, 0], "the cell took the focus ring");

  await pressWindow("j");
  await r.settle();
  assert.deepEqual(focused(r), [c, 1], "j moved a row down");

  await pressWindow("k");
  await r.settle();
  assert.deepEqual(focused(r), [c, 0], "k came back up");
});

test("j moves on a rollup cell too — nothing there takes typing", async (t) => {
  const r = await mountPane(t);
  const c = colOf("Sessions");

  await focusCell(r, c, 1);
  await pressWindow("j");
  await r.settle();
  assert.deepEqual(focused(r), [c, 2], "a derived column is nav, not typing");
});

test("h and l cross columns from a checkbox, and typing resumes where a cell takes it", async (t) => {
  const r = await mountPane(t);
  const done = colOf("Done");

  await focusCell(r, done, 0);
  await pressWindow("l");
  await r.settle();
  assert.deepEqual(focused(r), [done + 1, 0], "l stepped into the next column");

  await pressWindow("h");
  await r.settle();
  assert.deepEqual(focused(r), [done, 0], "h stepped back");

  // the mode is per-kind, not per-pane: on a column that DOES hold an editor
  // the same letter is the first character of a value and focus stays put
  const stage = colOf("Stage");
  await focusCell(r, stage, 0);
  await pressWindow("j");
  await r.settle();
  assert.deepEqual(focused(r), [stage, 0], "j typed into the cell instead of moving");
});
