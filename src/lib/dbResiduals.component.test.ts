/** Three table behaviours the pane owns that no pure helper can hold, each
    rendered for real (`componentHarness.ts`, pattern in
    `docs/component-tests.md`):
 *
 *    1. SPACE on a focused checkbox cell toggles it, like Enter and like a
 *       click. Without it the key falls through to the scroller and the
 *       focused row jumps a page instead — the one key most people reach for
 *       on a checkbox did nothing but scroll.
 *    2. Patching ONE pref field carries every other field through. The rebuild
 *       used to enumerate the fields it kept, so each field added to the pref
 *       since had to be remembered in that list too, and a forgotten one was
 *       thrown away on the next unrelated patch with no type error to show for
 *       it.
 *    3. The two row drops — onto a section header, onto another row — gather
 *       the dragged rows by ONE rule: this table's own rows, the whole
 *       selection when the dragged row is part of it, and a note dragged in
 *       from outside refused. They had two, so the same selection dropped two
 *       ways could reach two different sets of notes.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Residual";
const NOTE_MIME = "application/x-substrate-note";

/** Done toggles; Bundle is the kindless select the table groups by. */
const SCHEMA = {
  Done: { kind: "checkbox" },
  Bundle: { options: [{ value: "Delay" }, { value: "Reverb" }] },
} as unknown as Record<string, PropSchema>;

const { vaultCreate, vaultRead } = await import("./ipc.ts");

before(async () => {
  await mockBackend();
});

function paneProps(notes: NoteMeta[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: DB,
    notes,
    allNotes: notes,
    pref: { view: "table" },
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
  notes: NoteMeta[],
  over: Record<string, unknown> = {}
): Promise<Pane> {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return renderComponent(t, h(DatabasePane as never, paneProps(notes, over) as never));
}

let seq = 0;
/** real vault rows, so a toggle or a group write can be read back off disk */
async function rows(tag: string, props: [string, string][][]): Promise<NoteMeta[]> {
  const made: NoteMeta[] = [];
  for (const p of props) made.push(await vaultCreate(`Residual ${tag} ${++seq}`, "", DB, p, ""));
  return made;
}

/** the `data-fc` of a column, read off the rendered header — column order is
    derived from the notes and the schema, never handed in */
function colOf(r: Pane, name: string): number {
  const labels = r.all("th .db-th-label").map((b) => b.getAttribute("aria-label") ?? "");
  const i = labels.indexOf(`Sort by ${name}`);
  assert.ok(i >= 0, `no ${name} column among ${labels.join(", ")}`);
  return i + 1; // the Name column is 0
}

function cell(r: Pane, c: number, row: number): HTMLElement {
  const el = r.one(`td[data-fc="${c}"][data-fr="${row}"]`);
  assert.ok(el, `no cell at column ${c}, row ${row}`);
  return el as HTMLElement;
}

/** Focus the cell the way tabbing into it does — a click on a checkbox cell
    would toggle it, which is the gesture under test's rival, not its stand-in. */
async function focusCell(r: Pane, c: number, row: number): Promise<void> {
  await act(async () => {
    cell(r, c, row).dispatchEvent(new Event("focusin", { bubbles: true }));
  });
  await r.settle();
}

/** the pane's keyboard surface is bound to the window, the way App hands it
    over. Answers whether the pane CLAIMED the key — an unclaimed Space is the
    one that scrolls the pane out from under the focused row. */
async function pressWindow(key: string): Promise<boolean> {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    window.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}

/* ── 1: Space on a focused checkbox ──────────────────────────────────── */

test("Space toggles a focused checkbox cell, and claims the key", async (t) => {
  const [note] = await rows("Space", [[["Done", "true"]]]);
  const r = await mountPane(t, [{ ...note, props: { ...note.props, Done: true } }]);

  await focusCell(r, colOf(r, "Done"), 0);
  assert.ok(r.one("td.db-cell.focused"), "the checkbox cell never took the focus ring");

  const claimed = await pressWindow(" ");
  await r.settle();
  assert.ok(claimed, "Space fell through to the scroller instead of the cell");
  assert.equal(
    (await vaultRead(note.path)).props.Done,
    undefined,
    "Space left the checkbox as it was"
  );
});

test("Space on a cell that takes an editor is still a character, not a toggle", async (t) => {
  const [note] = await rows("SpaceText", [[["Bundle", "Delay"]]]);
  const r = await mountPane(t, [note]);

  await focusCell(r, colOf(r, "Bundle"), 0);
  await pressWindow(" ");
  await r.settle();
  assert.ok(r.one("td.db-cell"), "the table stopped rendering its data cells");
  assert.equal(
    (await vaultRead(note.path)).props.Bundle,
    "Delay",
    "Space toggled a cell that has an editor behind it"
  );
});

/* ── 2: patchPref carries the fields it was not handed ───────────────── */

test("patching one pref field carries every other field through", async (t) => {
  const notes = await rows("Pref", [[["Bundle", "Delay"]], [["Bundle", "Reverb"]]]);
  const patched: Record<string, unknown>[] = [];
  /* Every field the pref can hold, set to something recognisable — including
     ones the gesture below has nothing to do with. The rebuild must hand all
     of them back; the enumeration this replaced dropped whichever field its
     author forgot, silently and without a type error.

     `future_field` is the discriminator: an enumeration of today's fields
     cannot carry a field it has no name for, and the next field added to the
     pref is exactly that field until someone remembers this call. It is
     asserted on the PATCHED PREF and nowhere further — what survives the
     write is the persistence layer's business (App's `setDbPref` names the
     fields it stores), and this change owns only the rebuild. */
  const pref = {
    future_field: 1,
    view: "table",
    table_group_by: "Bundle",
    group_by: "Bundle",
    aggregations: { Bundle: "count" },
    sorts: [{ key: "Bundle", dir: 1 }],
    col_order: ["Bundle", "Done"],
    card_order: [notes[0].path],
    group_order: ["Delay", "Reverb"],
    hidden: ["Done"],
    hidden_per_layout: { table: ["Done"], list: [] },
    widths: { Bundle: 180 },
    wrap: ["Bundle"],
    grid: true,
  };
  const r = await mountPane(t, notes, {
    pref,
    onPrefChange: (p: Record<string, unknown>) => patched.push(p),
  });

  /* Folding a section is the smallest write through the pane's one pref
     door: it patches `collapsed_groups` and nothing else. */
  const fold = r
    .all("tr.db-group-tr button.db-group-disclose")
    .find((b) => (b.textContent ?? "").trim() === "Delay");
  assert.ok(fold, "no “Delay” section header to fold");
  await r.click(fold);
  await r.settle();

  assert.equal(patched.length, 1, "the fold wrote no pref");
  const next = patched[0];
  assert.deepEqual(next.collapsed_groups, ["Delay"], "the field being patched did not change");
  for (const key of Object.keys(pref))
    assert.deepEqual(next[key], pref[key as keyof typeof pref], `the rebuild dropped ${key}`);
  assert.equal(
    next.future_field,
    1,
    "the rebuild cannot carry a pref field it has no name for — it is enumerating again"
  );
});

/* ── 3: one gathering rule for both row drops ────────────────────────── */

/** jsdom has no drag-and-drop: the payload the handlers read is stubbed onto
    a plain event, which is all React needs to route it. */
function dragEvent(type: string, payload: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      types: [NOTE_MIME],
      setData: () => {},
      getData: () => payload,
      effectAllowed: "",
      dropEffect: "",
    },
  });
  return ev;
}

async function fire(el: Element, ev: Event): Promise<void> {
  await act(async () => {
    el.dispatchEvent(ev);
  });
}

function dataRows(r: Pane): Element[] {
  return r.all("tbody tr:not(.db-group-tr)");
}

/** the section header a group name labels — the group drop's target */
function groupHeader(r: Pane, label: string): Element {
  const found = r.all("tr.db-group-tr").find((tr) => (tr.textContent ?? "").includes(label));
  assert.ok(found, `no “${label}” section header`);
  return found;
}

/** the whole gesture: pick a row up, hover a section header, let go. The
    header only takes the drop while a row of THIS table is in hand, so the
    dragstart is part of the gesture, not setup. */
async function dragRowOntoGroup(
  r: Pane,
  fromRow: number,
  label: string,
  payload: string
): Promise<void> {
  const src = dataRows(r)[fromRow];
  assert.ok(src, `no row ${fromRow} to drag`);
  await fire(src, dragEvent("dragstart", payload));
  const head = groupHeader(r, label);
  await fire(head, dragEvent("dragover", payload));
  await r.settle();
  await fire(head, dragEvent("drop", payload));
  await r.settle();
}

/** ⌘-click a row's Name cell: the selection gesture, as the table wires it */
async function selectRow(r: Pane, i: number): Promise<void> {
  const cellEl = dataRows(r)[i]?.querySelector("td.db-title");
  assert.ok(cellEl, `row ${i} has no Name cell to select`);
  await act(async () => {
    cellEl.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
    );
  });
  await r.settle();
}

/** the path a painted row carries, which is what the drag payload is */
function pathAt(r: Pane, i: number): string {
  const td = dataRows(r)[i]?.querySelector("td[data-focus-path]");
  assert.ok(td, `row ${i} carried no path`);
  return td.getAttribute("data-focus-path") ?? "";
}

test("a note dragged in from outside is refused by the group drop, as by the row drop", async (t) => {
  const notes = await rows("Foreign", [[["Bundle", "Delay"]], [["Bundle", "Reverb"]]]);
  const outsider = await vaultCreate("Residual Outsider", "", "Other", [], "");
  const r = await mountPane(t, notes, {
    pref: { view: "table", table_group_by: "Bundle" },
  });

  // a row of this table in hand, a foreign payload released: the guard is on
  // the payload, not on the drag having started somewhere plausible
  await dragRowOntoGroup(r, 0, "Reverb", outsider.path);
  assert.equal(
    (await vaultRead(outsider.path)).props.Bundle,
    undefined,
    "the group drop wrote the grouped property into a note this table never showed"
  );

  // the positive half: this table's own row still takes the same drop
  const own = pathAt(r, 0);
  await dragRowOntoGroup(r, 0, "Reverb", own);
  assert.equal(
    (await vaultRead(own)).props.Bundle,
    "Reverb",
    "the group drop stopped taking its own rows"
  );
});

test("a selection dropped on a section header carries the whole selection", async (t) => {
  const notes = await rows("Sel", [
    [["Bundle", "Delay"]],
    [["Bundle", "Delay"]],
    [["Bundle", "Reverb"]],
  ]);
  const r = await mountPane(t, notes, {
    pref: { view: "table", table_group_by: "Bundle" },
  });

  await selectRow(r, 0);
  await selectRow(r, 1);
  const held = [pathAt(r, 0), pathAt(r, 1)];
  await dragRowOntoGroup(r, 0, "Reverb", held[0]);

  for (const p of held)
    assert.equal(
      (await vaultRead(p)).props.Bundle,
      "Reverb",
      `${p} was left behind by the group drop`
    );
  assert.equal(r.all("tbody tr.selected").length, 0, "the selection outlived the drop");
});
