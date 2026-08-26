/** Dragging a table row ONTO another row: the prompt, and what it writes.
 *
 *  The gesture is deliberately two-stage. The drop gathers the rows and
 *  raises a prompt; nothing reaches disk until the prompt is confirmed,
 *  because a drop onto a row is easy to make by accident while dragging rows
 *  around. What has to hold, and what tsc cannot see:
 *
 *    1. a drop on the MIDDLE of another row opens the prompt and writes
 *       nothing — Escape and Cancel leave the table exactly as it was;
 *    2. only that middle band takes the drop, so a pointer travelling near a
 *       row boundary never reads as a grouping;
 *    3. confirming writes the group value on BOTH rows through the pane's
 *       one bulk door: a single undo entry across the pair;
 *    4. an ungrouped table establishes its grouping in the same confirm —
 *       the property is created, the table starts grouping by it, and the
 *       rows take the value;
 *    5. a row dropped on itself, and a note dragged in from outside this
 *       table, are refused before any prompt appears;
 *    6. the establish path is ORDERED — the schema write is awaited and a
 *       refusal ends the confirm, and the table only regroups once a row is
 *       carrying the value, while promoting into a property that is already
 *       there is ATOMIC — one undo takes back the rows AND the option;
 *    7. what the prompt will accept as a property: not a column that is
 *       already there, not one of the names the app keeps for itself, and
 *       not a kinded column it would have to invent a value for;
 *    8. the promote door is the whole confirm, not just its option: the
 *       column's description rides the write, a refusal or a set of rows
 *       that all fail leaves the vault where it started and records
 *       nothing, and the app's OWN door — mounted here, not stood in for —
 *       still hands the confirm back the promise its grouping switch waits
 *       on.
 *
 *  Harness written up in `docs/component-tests.md`. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { addOptionAndWriteUndoable } from "./undoschema.ts";
import { UndoContext } from "./undoContext.ts";
import type { UndoEntry } from "./undo.ts";
import type { UndoRecorder } from "./undoprops.ts";
import type { NoteMeta, PropKind, PropSchema, SelectOption } from "./types.ts";

const DB = "RowGroup";
const NOTE_MIME = "application/x-substrate-note";

/** Bundle is a select — a kindless schema entry carrying options — which is
    what makes it the grouping column the prompt opens on. Its description is
    the thing a promote must not quietly drop, and Due is the kinded column
    the establish step has no business offering. */
const BUNDLE_DESC = "which crate this ships in";
const SCHEMA = {
  Bundle: { options: [{ value: "Delay" }], description: BUNDLE_DESC },
  Note: { kind: "text" },
  Due: { kind: "date" },
  Weight: { kind: "number" },
} as unknown as Record<string, PropSchema>;

/** the argument list `onSaveSchema` takes, as far as this gesture uses it:
    the property, its options, its kind, then four fields it has nothing to
    say about, then the description */
type SchemaSave = [string, unknown, unknown, unknown, unknown, unknown, unknown, unknown];

const { vaultCreate, vaultRead, vaultSchemaRead } = await import("./ipc.ts");

before(async () => {
  await mockBackend();
});

/** jsdom has no drag-and-drop: the payload the handlers read is stubbed onto
    a plain event, which is all React needs to route it. A row drag also
    carries the pointer's y — which band of the row it is over decides
    whether that row is a grouping target at all. */
function dragEvent(type: string, payload: string, clientY?: number): Event {
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
  if (clientY !== undefined) Object.defineProperty(ev, "clientY", { value: clientY });
  return ev;
}

/** jsdom measures every box as zero, and the middle-band test is measured —
    so the row under the pointer is given a real one. Top 100, height 32:
    MIDDLE is dead centre, EDGE sits inside the inert top quarter. */
const MIDDLE = 116;
const EDGE = 103;

function boxRow(tr: Element): void {
  Object.defineProperty(tr, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, bottom: 132, left: 0, right: 400, width: 400, height: 32 }),
  });
}

async function fire(el: Element, ev: Event): Promise<void> {
  await act(async () => {
    el.dispatchEvent(ev);
  });
}

/** Every prop the pane needs, with everything these tests don't drive inert
    — built loosely on purpose, the way the other pane harnesses are. */
function paneProps(notes: NoteMeta[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: DB,
    notes,
    allNotes: notes,
    pref: { view: "table", cols: ["Bundle"] },
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

/** the pane under a recorder, so a confirmed drop's undo entry is
    inspectable */
async function mountPane(
  t: Parameters<typeof renderComponent>[0],
  notes: NoteMeta[],
  recorded: Omit<UndoEntry, "id">[],
  over: Record<string, unknown> = {}
) {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return renderComponent(
    t,
    h(
      UndoContext.Provider,
      { value: { record: (e: Omit<UndoEntry, "id">) => recorded.push(e), runById: () => {} } },
      h(DatabasePane as never, paneProps(notes, over) as never)
    )
  );
}

type Pane = Awaited<ReturnType<typeof mountPane>>;

/** the data rows only — a grouped table also draws a section header per
    group, and those are a different drop target entirely */
function dataRows(r: Pane): Element[] {
  return r.all("tbody tr:not(.db-group-tr)");
}

/** the paths the pane under test was mounted with, in render order */
let mountedPaths: string[] = [];

/** the whole gesture up to the release: grab one row, hover another, drop.
    `clientY` picks the band the pointer is in. */
async function dragRowOnto(r: Pane, from: number, onto: number, clientY = MIDDLE): Promise<void> {
  const rows = dataRows(r);
  const src = rows[from];
  const dst = rows[onto];
  const path = mountedPaths[from];
  boxRow(dst);
  await fire(src, dragEvent("dragstart", path));
  await fire(dst, dragEvent("dragover", path, clientY));
  await r.settle();
  await fire(dst, dragEvent("drop", path, clientY));
  await r.settle();
}

function prompt(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Group these rows"]');
}

function field(label: string): HTMLInputElement & HTMLSelectElement {
  const el = prompt()?.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(el, `no “${label}” field in the prompt`);
  return el as HTMLInputElement & HTMLSelectElement;
}

/** React tracks a controlled field's value on the node itself, so a plain
    assignment looks like no change — the prototype setter is the way in */
async function type(label: string, value: string): Promise<void> {
  const el = field(label);
  const select = el.tagName === "SELECT";
  // the element's OWN prototype: jsdom's constructors live on its window, and
  // only some of them are installed as globals here
  const proto = Object.getPrototypeOf(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  });
}

async function press(label: string): Promise<void> {
  const found = [...(prompt()?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === label
  );
  assert.ok(found, `no “${label}” button in the prompt`);
  await act(async () => {
    found.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** the prompt's primary button, whether or not it is currently taking a
    click — `press` only finds the ones that are */
function confirmBtn(): HTMLButtonElement {
  const found = [...(prompt()?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === "Group"
  );
  assert.ok(found, "no “Group” button in the prompt");
  return found;
}

/** the inline reason the prompt is refusing, or null while it isn't */
function refusal(): string | null {
  return prompt()?.querySelector(".dbform-err")?.textContent ?? null;
}

/** ⌘-click a row's Name cell: the selection gesture, as the table wires it */
async function selectRow(r: Pane, i: number): Promise<void> {
  const cell = dataRows(r)[i].querySelector("td.db-title");
  assert.ok(cell, `row ${i} has no Name cell to select`);
  await act(async () => {
    cell.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
    );
  });
  await r.settle();
}

/** two fresh rows in a table grouped by Bundle, unless the pref is overridden */
async function twoRows(
  t: Parameters<typeof renderComponent>[0],
  tag: string,
  recorded: Omit<UndoEntry, "id">[] = [],
  over: Record<string, unknown> = {}
): Promise<{ r: Pane; a: NoteMeta; b: NoteMeta }> {
  const a = await vaultCreate(`Row Group ${tag} A`, "", DB, [], "");
  const b = await vaultCreate(`Row Group ${tag} B`, "", DB, [], "");
  mountedPaths = [a.path, b.path];
  const r = await mountPane(t, [a, b], recorded, {
    pref: { view: "table", cols: ["Bundle"], table_group_by: "Bundle" },
    ...over,
  });
  return { r, a, b };
}

/** three fresh rows, for the gestures that carry a whole selection */
async function threeRows(
  t: Parameters<typeof renderComponent>[0],
  tag: string,
  recorded: Omit<UndoEntry, "id">[] = [],
  over: Record<string, unknown> = {}
): Promise<{ r: Pane; notes: NoteMeta[] }> {
  const notes: NoteMeta[] = [];
  for (const suffix of ["A", "B", "C"])
    notes.push(await vaultCreate(`Row Group ${tag} ${suffix}`, "", DB, [], ""));
  mountedPaths = notes.map((n) => n.path);
  const r = await mountPane(t, notes, recorded, {
    pref: { view: "table", cols: ["Bundle"], table_group_by: "Bundle" },
    ...over,
  });
  return { r, notes };
}

test("a row dropped on the middle of another opens the prompt and writes nothing", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const { r, a, b } = await twoRows(t, "Open", recorded);

  await dragRowOnto(r, 0, 1);

  assert.ok(prompt(), "the drop raised no prompt");
  assert.equal(recorded.length, 0, "the drop itself recorded an undoable write");
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined, "the drop wrote before confirming");
  assert.equal((await vaultRead(b.path)).props.Bundle, undefined, "the drop wrote before confirming");
});

test("a drop near a row's edge is not a grouping — no prompt, no write", async (t) => {
  const { r } = await twoRows(t, "Edge");

  const rows = dataRows(r);
  boxRow(rows[1]);
  await fire(rows[0], dragEvent("dragstart", mountedPaths[0]));
  // lit first, so what follows is about the BAND and not about the drag: the
  // same pointer over the same row, one quarter higher, takes nothing
  await fire(rows[1], dragEvent("dragover", mountedPaths[0], MIDDLE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 1, "the middle band lit nothing to begin with");

  // the outer quarters are inert on purpose: that band is where a drag
  // travelling BETWEEN rows passes
  await fire(rows[1], dragEvent("dragover", mountedPaths[0], EDGE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 0, "the inert edge stayed lit");

  await fire(rows[1], dragEvent("drop", mountedPaths[0], EDGE));
  await r.settle();
  assert.equal(prompt(), null, "the row's inert edge took the drop anyway");
});

test("hovering the middle lights the target row, hovering its edge drops the light", async (t) => {
  const { r } = await twoRows(t, "Lit");

  const rows = dataRows(r);
  boxRow(rows[1]);
  await fire(rows[0], dragEvent("dragstart", mountedPaths[0]));
  await fire(rows[1], dragEvent("dragover", mountedPaths[0], MIDDLE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 1, "the middle band lit nothing");

  await fire(rows[1], dragEvent("dragover", mountedPaths[0], EDGE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 0, "the light survived the pointer leaving the band");
});

test("Escape and Cancel both dismiss the prompt without writing", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const { r, a, b } = await twoRows(t, "Dismiss", recorded);

  await dragRowOnto(r, 0, 1);
  await type("Group name", "Shelved");
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await r.settle();
  assert.equal(prompt(), null, "Escape left the prompt up");
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined, "Escape still wrote");

  await dragRowOnto(r, 0, 1);
  await type("Group name", "Shelved");
  await press("Cancel");
  await r.settle();
  assert.equal(prompt(), null, "Cancel left the prompt up");
  assert.equal(recorded.length, 0, "a dismissed prompt recorded an undoable write");
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined, "Cancel still wrote");
  assert.equal((await vaultRead(b.path)).props.Bundle, undefined, "Cancel still wrote");
});

test("confirming writes the group value on both rows, as one undo entry", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const { r, a, b } = await twoRows(t, "Write", recorded);

  await dragRowOnto(r, 0, 1);
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  assert.equal(prompt(), null, "the prompt stayed up past its own confirm");
  assert.equal((await vaultRead(a.path)).props.Bundle, "Shelved");
  assert.equal((await vaultRead(b.path)).props.Bundle, "Shelved");
  assert.equal(recorded.length, 1, "two rows grouped, and not one undoable action");
  assert.deepEqual([...(recorded[0].paths ?? [])].sort(), [a.path, b.path].sort());

  // and taking it back takes both rows back out of the group
  await act(async () => {
    await recorded[0].undo();
  });
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined);
  assert.equal((await vaultRead(b.path)).props.Bundle, undefined);
});

test("an ungrouped table establishes its grouping in the same confirm", async (t) => {
  const prefs: Record<string, unknown>[] = [];
  const schemaSaves: { prop: string; options: unknown }[] = [];
  const { r, a, b } = await twoRows(t, "New", [], {
    // no table_group_by: the prompt has to establish the grouping itself
    pref: { view: "table", cols: ["Bundle"] },
    onPrefChange: (p: Record<string, unknown>) => prefs.push(p),
    onSaveSchema: (prop: string, options: unknown) => schemaSaves.push({ prop, options }),
  });

  await dragRowOnto(r, 0, 1);
  // the property step exists only while the table is ungrouped
  const picker = field("Group by property");
  assert.ok(
    [...picker.options].some((o) => o.textContent?.trim() === "New property…"),
    "the prompt offered no way to invent a grouping property"
  );
  await type("Group by property", "");
  await type("New property name", "Shelf");
  await type("Group name", "Top");
  await press("Group");
  await r.settle();

  assert.deepEqual(
    schemaSaves,
    [{ prop: "Shelf", options: [{ value: "Top" }] }],
    "the invented property did not reach the schema as a select carrying its first group"
  );
  assert.equal(
    prefs[prefs.length - 1]?.table_group_by,
    "Shelf",
    "the table did not start grouping by the property the prompt made"
  );
  assert.equal((await vaultRead(a.path)).props.Shelf, "Top");
  assert.equal((await vaultRead(b.path)).props.Shelf, "Top");
});

test("a row dropped on itself is refused before any prompt", async (t) => {
  const { r } = await twoRows(t, "Self");

  await dragRowOnto(r, 0, 0);

  assert.equal(prompt(), null, "a row grouped with itself");
  assert.equal(r.all("tr.row-group-drop").length, 0, "the dragged row lit itself as a target");
});

test("a note dragged in from outside this table is refused", async (t) => {
  const { r } = await twoRows(t, "Foreign");

  const rows = dataRows(r);
  boxRow(rows[1]);
  /* The same hover with one of THIS table's rows in hand does light the
     target — established first so what follows is about where the drag came
     from, and not about a hover that was never going to light anything. */
  await fire(rows[0], dragEvent("dragstart", mountedPaths[0]));
  await fire(rows[1], dragEvent("dragover", mountedPaths[0], MIDDLE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 1, "the in-table hover lit nothing to begin with");
  await fire(rows[0], dragEvent("dragend", mountedPaths[0]));
  await r.settle();

  // now the drag begins somewhere else entirely — the sidebar, another pane —
  // so this table has no row in hand, though the drag carries the same note
  // type
  await fire(rows[1], dragEvent("dragover", "Somewhere Else.md", MIDDLE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 0, "a foreign drag lit a row as a target");

  await fire(rows[1], dragEvent("drop", "Somewhere Else.md", MIDDLE));
  await r.settle();
  assert.equal(prompt(), null, "a foreign drag raised the grouping prompt");
});

test("a foreign payload is refused mid-drag, with a row of this table in hand", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const { r } = await twoRows(t, "Payload", recorded);

  /* The drag is this table's own — the row is in hand, the target row is
     real, the band lights. What arrives on the release is a path this
     database never showed. Nothing about the gesture says so until the
     payload is read, which is why the guard cannot live in the hover. */
  const rows = dataRows(r);
  boxRow(rows[1]);
  await fire(rows[0], dragEvent("dragstart", mountedPaths[0]));
  await fire(rows[1], dragEvent("dragover", mountedPaths[0], MIDDLE));
  await r.settle();
  assert.equal(r.all("tr.row-group-drop").length, 1, "an in-table drag lit nothing");

  await fire(rows[1], dragEvent("drop", "Somewhere Else.md", MIDDLE));
  await r.settle();
  assert.equal(prompt(), null, "a foreign payload raised the grouping prompt");
  assert.equal(recorded.length, 0, "a foreign payload wrote");
});

test("promoting a group name into an existing property keeps its description", async (t) => {
  const saves: SchemaSave[] = [];
  const { r } = await twoRows(t, "Promote", [], {
    onSaveSchema: (...args: SchemaSave) => saves.push(args),
  });

  await dragRowOnto(r, 0, 1);
  // "Shelved" is a spelling Bundle's schema has never seen, so confirming
  // promotes it into the column's options
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  assert.deepEqual(
    saves,
    [
      [
        "Bundle",
        [{ value: "Delay" }, { value: "Shelved" }],
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        BUNDLE_DESC,
      ],
    ],
    "the promote did not carry the column's own description through"
  );
});

/** what the pane composes for the door: the option list either side of the
    promote, the kind either side of it, and the description the column
    already carries */
type PromoteAdd = {
  before: SelectOption[];
  after: SelectOption[];
  kind: PropKind | null;
  priorKind: PropKind | null;
  description?: string;
};

/** The app's own `onPromoteOption`, small enough to read: the schema lives
    in a box the test can inspect, and the pair rides the real promote door.
    Whatever the pane hands `writeValue` is folded into the ONE entry this
    records, which is the thing under test.

    The box takes the description along with the options because the app's
    door does: one schema write carries both, so a description dropped on the
    way in is visible here as a box that lost it. `refuseWrite` is the vault
    turning that write down, and the swallowed rejection is the app's too —
    its door ends on a toast, so a refusal reaches the confirm as a promise
    that resolved having written nothing. */
function promoteDoor(
  schemaBox: { options: SelectOption[]; description?: string },
  recorded: Omit<UndoEntry, "id">[],
  over: { refuseWrite?: boolean; onAdd?: (add: PromoteAdd) => void } = {}
) {
  return (
    _prop: string,
    add: PromoteAdd,
    writeValue: (record: UndoRecorder) => Promise<void>
  ) => {
    over.onAdd?.(add);
    return addOptionAndWriteUndoable({
      store: {
        before: { options: add.before, kind: add.priorKind },
        after: { options: add.after, kind: add.kind },
        write: (state) => {
          if (over.refuseWrite)
            return Promise.reject(new Error("the vault will not take that option"));
          schemaBox.options = state.options;
          schemaBox.description = add.description;
          return Promise.resolve();
        },
        read: () => Promise.resolve(schemaBox.options),
      },
      writeValue,
      record: (e) => recorded.push(e),
    }).catch((e) => {
      // the app's door ends on a toast, so a refused write reaches the
      // confirm as a promise that resolved having written nothing. Only
      // there: everywhere else a rejection out of the door is a fault this
      // file wants to hear about, not swallow.
      if (!over.refuseWrite) throw e;
    });
  };
}

test("one undo after a promoted group takes back the rows and the option", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const schemaBox = { options: [{ value: "Delay" }] as SelectOption[] };
  const { r, a, b } = await twoRows(t, "Atomic", recorded, {
    onPromoteOption: promoteDoor(schemaBox, recorded),
  });

  await dragRowOnto(r, 0, 1);
  // a spelling Bundle's schema has never seen: confirming has to invent the
  // option and write the rows as one action
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  assert.deepEqual(
    schemaBox.options,
    [{ value: "Delay" }, { value: "Shelved" }],
    "the promoted group name never reached the column's options"
  );
  assert.equal((await vaultRead(a.path)).props.Bundle, "Shelved");
  assert.equal((await vaultRead(b.path)).props.Bundle, "Shelved");
  assert.equal(recorded.length, 1, "the option and the rows recorded two undo steps, not one");

  await act(async () => {
    await recorded[0].undo();
  });
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined, "undo left a row in the group");
  assert.equal((await vaultRead(b.path)).props.Bundle, undefined, "undo left a row in the group");
  assert.deepEqual(
    schemaBox.options,
    [{ value: "Delay" }],
    "undo took the rows back and left the invented option standing in the schema"
  );
});

test("a promoted group name carries the column's description through the door", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  // seeded stale on purpose: a box that already held the right description
  // would read the same whether the write carried one or not
  const schemaBox = { options: [{ value: "Delay" }] as SelectOption[], description: "stale" };
  /* The door path composes its own schema write, so the description the
     column already carries has to be put ON that write by the pane — the
     fallback path's description is a different line of code, and the
     existing description test only ever runs that one. A promote that
     forgets it wipes the column's description while adding an option. */
  const seen: PromoteAdd[] = [];
  const { r } = await twoRows(t, "PromoteDesc", recorded, {
    onPromoteOption: promoteDoor(schemaBox, recorded, { onAdd: (add) => seen.push(add) }),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  assert.equal(
    seen[0]?.description,
    BUNDLE_DESC,
    "the pane sent the promote door no description, so the door's schema write cleared it"
  );
  assert.equal(
    schemaBox.description,
    BUNDLE_DESC,
    "the description did not survive the write that stored the promoted option"
  );
  assert.deepEqual(schemaBox.options, [{ value: "Delay" }, { value: "Shelved" }]);
});

test("a promote the vault refuses writes no rows and leaves the grouping alone", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const prefs: Record<string, unknown>[] = [];
  const schemaBox = { options: [{ value: "Delay" }] as SelectOption[] };
  /* The door's own suite pins that a refused option write stops before the
     value. What is pinned HERE is the confirm around it: the rows this
     gesture had in hand stay unwritten, nothing is takeable back, and the
     table does not start grouping by a column the schema never took. */
  const seen: PromoteAdd[] = [];
  const { r, a, b } = await twoRows(t, "PromoteRefused", recorded, {
    pref: { view: "table", cols: ["Bundle"] },
    onPrefChange: (p: Record<string, unknown>) => prefs.push(p),
    onPromoteOption: promoteDoor(schemaBox, recorded, {
      refuseWrite: true,
      onAdd: (add) => seen.push(add),
    }),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group by property", "Bundle");
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  assert.equal(seen.length, 1, "the confirm never reached the promote door to be refused");
  assert.deepEqual(schemaBox.options, [{ value: "Delay" }], "a refused write reached the schema");
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined, "a refused promote still wrote a row");
  assert.equal((await vaultRead(b.path)).props.Bundle, undefined, "a refused promote still wrote a row");
  assert.equal(recorded.length, 0, "a promote that wrote nothing left an undo entry behind");
  assert.equal(
    prefs.some((p) => p.table_group_by === "Bundle"),
    false,
    "the table regrouped onto a promote the vault refused"
  );
});

test("rows that all fail on the promote door take the invented option back out", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const prefs: Record<string, unknown>[] = [];
  const schemaBox = { options: [{ value: "Delay" }] as SelectOption[] };
  /* The option is stored first, so a set of rows that ALL refuse the value
     leaves it standing on its own unless the door takes it back — an option
     in the column's list that no row carries and no undo can remove. The
     rollback lives in the door; that it survives the confirm around it,
     with no entry recorded and no grouping switch, is this. */
  const seen: PromoteAdd[] = [];
  const { r, a } = await twoRows(t, "PromoteNoWrite", recorded, {
    pref: { view: "table", cols: ["Bundle"] },
    onPrefChange: (p: Record<string, unknown>) => prefs.push(p),
    onPromoteOption: promoteDoor(schemaBox, recorded, { onAdd: (add) => seen.push(add) }),
    writeProp: () => Promise.reject(new Error("the vault is read-only")),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group by property", "Bundle");
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  /* Every other assertion here is an absence, and an absence reads the same
     whether the option was stored and taken back out or the confirm never
     reached the door at all — so the door being entered is asserted first. */
  assert.deepEqual(
    seen.map((add) => add.after),
    [[{ value: "Delay" }, { value: "Shelved" }]],
    "the confirm never reached the promote door, so what follows proves nothing"
  );
  assert.deepEqual(
    schemaBox.options,
    [{ value: "Delay" }],
    "the promoted option stayed in the schema though not one row took the value"
  );
  assert.equal(recorded.length, 0, "a promote nothing landed from recorded an undo entry");
  assert.equal((await vaultRead(a.path)).props.Bundle, undefined);
  assert.equal(
    prefs.some((p) => p.table_group_by === "Bundle"),
    false,
    "the table regrouped onto a column not one row took"
  );
});

test("a group name the property already carries is not promoted again", async (t) => {
  const saves: SchemaSave[] = [];
  const { r, a } = await twoRows(t, "Known", [], {
    onSaveSchema: (...args: SchemaSave) => saves.push(args),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group name", "delay"); // Bundle's own option, differently cased
  await press("Group");
  await r.settle();

  assert.deepEqual(saves, [], "a value the schema already carries was written to it again");
  assert.equal((await vaultRead(a.path)).props.Bundle, "delay");
});

test("a dragged row that is selected carries the whole selection into the group", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  const { r, notes } = await threeRows(t, "Sel", recorded);

  await selectRow(r, 0);
  await selectRow(r, 1);
  // the third row is the one landed on: it joins the group without being
  // selected, the way the section-header drop treats its target
  await dragRowOnto(r, 0, 2);

  assert.ok(prompt(), "a selected row's drop raised no prompt");
  assert.match(prompt()!.textContent ?? "", /Group these 3 rows/);
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  for (const n of notes)
    assert.equal((await vaultRead(n.path)).props.Bundle, "Shelved", `${n.path} missed the group`);
  assert.equal(recorded.length, 1, "three rows grouped, and not one undoable action");
  assert.equal(r.all("tbody tr.is-selected").length, 0, "the selection outlived the drop");
});

/** The pane's pref is fed from outside, so a fold only takes effect when the
    caller feeds the new pref back — which is what App does. */
async function mountFoldable(
  t: Parameters<typeof renderComponent>[0],
  notes: NoteMeta[],
  recorded: Omit<UndoEntry, "id">[],
  initialPref: Record<string, unknown>
): Promise<Pane> {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const { useState } = await import("react");
  const Host = () => {
    const [pref, setPref] = useState<Record<string, unknown>>(initialPref);
    return h(
      DatabasePane as never,
      paneProps(notes, {
        pref,
        onPrefChange: (next: Record<string, unknown>) => setPref(next),
      }) as never
    );
  };
  return renderComponent(
    t,
    h(
      UndoContext.Provider,
      { value: { record: (e: Omit<UndoEntry, "id">) => recorded.push(e), runById: () => {} } },
      h(Host)
    )
  );
}

/** fold the section a header names, through the disclosure the user clicks */
async function foldSection(r: Pane, label: string): Promise<void> {
  const disclose = () =>
    r
      .all("tr.db-group-tr button.db-group-disclose")
      .find((b) => (b.textContent ?? "").trim() === label);
  const head = disclose();
  assert.ok(head, `no “${label}” section header to fold`);
  await r.click(head);
  await r.settle();
  assert.equal(
    disclose()?.getAttribute("aria-expanded"),
    "false",
    `the “${label}” section did not fold`
  );
}

test("a selection reaching into a folded section is grouped whole", async (t) => {
  const recorded: Omit<UndoEntry, "id">[] = [];
  /* Two sections: Delay holds the pair the drag happens between, Reverb holds
     the row that will be folded away while still selected. */
  const a = await vaultCreate("Row Group Fold A", "", DB, [["Bundle", "Delay"]], "");
  const b = await vaultCreate("Row Group Fold B", "", DB, [["Bundle", "Delay"]], "");
  const c = await vaultCreate("Row Group Fold C", "", DB, [["Bundle", "Reverb"]], "");
  const notes = [a, b, c].map((n, i) => ({
    ...n,
    props: { ...n.props, Bundle: i < 2 ? "Delay" : "Reverb" },
  }));
  mountedPaths = notes.map((n) => n.path);
  const r = await mountFoldable(t, notes, recorded, {
    view: "table",
    cols: ["Bundle"],
    table_group_by: "Bundle",
  });

  await selectRow(r, 0); // Delay
  await selectRow(r, 2); // Reverb — the one about to be hidden
  await foldSection(r, "Reverb");

  /* Folding is a view state, not a filter: the selection deliberately keeps
     the rows a fold hides (the prune runs against the unfolded set), so the
     gesture has to carry them too. Reading the PAINTED rows dropped exactly
     the members the fold was hiding. */
  mountedPaths = [notes[0].path, notes[1].path];
  await dragRowOnto(r, 0, 1);

  assert.ok(prompt(), "the drop raised no prompt");
  assert.match(prompt()!.textContent ?? "", /Group these 3 rows/, "the folded row was counted out");
  await type("Group name", "Shelved");
  await press("Group");
  await r.settle();

  for (const n of notes)
    assert.equal((await vaultRead(n.path)).props.Bundle, "Shelved", `${n.path} missed the group`);
  assert.equal(recorded.length, 1, "three rows grouped, and not one undoable action");
});

test("a row dropped on another row of the same selection is refused", async (t) => {
  const { r } = await threeRows(t, "SelSame");

  await selectRow(r, 0);
  await selectRow(r, 1);
  // both ends of this drag are already in hand: there is no pair to group,
  // and the drag is the selection being moved, not two rows meeting
  await dragRowOnto(r, 0, 1);

  assert.equal(prompt(), null, "two rows of one selection raised the grouping prompt");
  assert.equal(r.all("tr.row-group-drop").length, 0, "a selected row lit as a target for its own selection");
});

test("a new property may not take one of the names the app keeps for itself", async (t) => {
  const saves: SchemaSave[] = [];
  const { r, a } = await twoRows(t, "Reserved", [], {
    pref: { view: "table", cols: ["Bundle"] },
    onSaveSchema: (...args: SchemaSave) => saves.push(args),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group by property", "");
  // cased differently on purpose: `type` is the key that would move both
  // rows out of this database, whatever the user spells it
  await type("New property name", "Type");
  await type("Group name", "Shelved");

  assert.match(refusal() ?? "", /keeps for itself/, "a reserved name drew no refusal");
  assert.equal(confirmBtn().disabled, true, "the confirm took a reserved property name");

  await press("Group");
  await r.settle();
  assert.deepEqual(saves, [], "a reserved name reached the schema");
  assert.equal((await vaultRead(a.path)).props.Type, undefined, "a reserved name reached a row");

  // the same treatment a name that collides with a real column gets — one
  // refusal line, one disabled confirm
  await type("New property name", "bundle");
  assert.match(refusal() ?? "", /already a column/, "a colliding name drew no refusal");
  assert.equal(confirmBtn().disabled, true, "the confirm took a colliding property name");
});

test("establishing a grouping offers kindless columns only", async (t) => {
  const { r } = await twoRows(t, "Kindless", [], {
    pref: { view: "table", cols: ["Bundle", "Due"] },
  });

  await dragRowOnto(r, 0, 1);
  const offered = [...field("Group by property").options].map((o) => o.value);

  assert.ok(offered.includes("Bundle"), "the select column was not offered");
  assert.ok(
    !offered.includes("Due"),
    "a date column was offered a grouping the prompt would fill by free text"
  );
  // the invent-one entry is always last, and carries the empty value
  assert.ok(offered.includes(""), "the prompt offered no way to invent a property");
});

test("a refused schema write stops the confirm before anything else is written", async (t) => {
  const prefs: Record<string, unknown>[] = [];
  const { r, a, b } = await twoRows(t, "Refused", [], {
    pref: { view: "table", cols: ["Bundle"] },
    onPrefChange: (p: Record<string, unknown>) => prefs.push(p),
    // what the engine does with a name it will not take: the app has already
    // put the reason on its toast by the time this resolves
    onSaveSchema: () => Promise.resolve(false),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group by property", "");
  await type("New property name", "Shelf");
  await type("Group name", "Top");
  await press("Group");
  await r.settle();

  assert.equal(
    prefs.some((p) => p.table_group_by === "Shelf"),
    false,
    "the table started grouping by a property the engine refused"
  );
  assert.equal((await vaultRead(a.path)).props.Shelf, undefined, "a refused property reached a row");
  assert.equal((await vaultRead(b.path)).props.Shelf, undefined, "a refused property reached a row");
});

test("rows that all fail to write leave the table's grouping alone", async (t) => {
  const prefs: Record<string, unknown>[] = [];
  const saves: SchemaSave[] = [];
  const { r } = await twoRows(t, "NoWrite", [], {
    pref: { view: "table", cols: ["Bundle"] },
    onPrefChange: (p: Record<string, unknown>) => prefs.push(p),
    onSaveSchema: (...args: SchemaSave) => saves.push(args),
    writeProp: () => Promise.reject(new Error("the vault is read-only")),
  });

  await dragRowOnto(r, 0, 1);
  await type("Group by property", "");
  await type("New property name", "Shelf");
  await type("Group name", "Top");
  await press("Group");
  await r.settle();

  assert.equal(saves.length, 1, "the property the prompt invented never reached the schema");
  /* A table that regroups onto a column no row carries shows every row under
     "No Shelf" — the gesture reading as though it had worked on a table
     where nothing did. The property staying behind is the accepted residue;
     the grouping switch is not. */
  assert.equal(
    prefs.some((p) => p.table_group_by === "Shelf"),
    false,
    "the table regrouped onto a column not one row took"
  );
});

test("a table grouped by a kinded column normalizes the typed value", async (t) => {
  const saves: SchemaSave[] = [];
  const { r, a, b } = await twoRows(t, "Kinded", [], {
    pref: { view: "table", cols: ["Weight"], table_group_by: "Weight" },
    onSaveSchema: (...args: SchemaSave) => saves.push(args),
  });

  await dragRowOnto(r, 0, 1);
  // a number column stores canonical dot-decimal however the app renders it,
  // so the typed group name goes through the door a typed cell goes through
  await type("Group name", "1.234,56");
  await press("Group");
  await r.settle();

  assert.equal((await vaultRead(a.path)).props.Weight, "1234.56");
  assert.equal((await vaultRead(b.path)).props.Weight, "1234.56");
  assert.deepEqual(saves, [], "a kinded column took a select option it has no use for");
});

/** The last seam this gesture rests on is not in the pane at all. Promoting
    into an existing property hands the confirm the app's own promote door,
    and that door has to RETURN the promise it starts: the confirm awaits it,
    and the grouping switch it makes afterwards fires only once a row is
    carrying the value. A door that starts its work and hands back nothing
    leaves every test above green while a promoted drop quietly stops
    regrouping the table — so this one mounts the whole app and drops a row
    on a row in a real database, with no stand-in anywhere in the path.

    The mock vault's task database is the fixture: an ungrouped table whose
    `status` is a kindless select, which is exactly what sends a spelling it
    has never seen through the promote door. */
test("the app's own promote door hands the confirm back its grouping switch", async (t) => {
  const { default: App } = await import("../App.tsx");
  const r = await renderComponent(t, h(App as never, {} as never));

  const open = r
    .all(".sidebar button")
    .find((b) => b.textContent?.trim() === "🎵TasksDB");
  assert.ok(open, "the sidebar showed no task database to open");
  await act(async () => {
    open.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await r.settle();

  assert.equal(
    r.all("tbody tr.db-group-tr").length,
    0,
    "the table was already drawing group sections before the drop"
  );
  // the app's rows carry their own paths, which is what the drag payload is
  mountedPaths = dataRows(r).map((tr) => {
    const cell = tr.querySelector("td[data-focus-path]");
    assert.ok(cell, "a table row carried no path for the drag to pick up");
    return cell.getAttribute("data-focus-path") ?? "";
  });

  await dragRowOnto(r, 0, 1);
  assert.ok(prompt(), "the drop raised no prompt in the app");
  await type("Group by property", "status");
  // a spelling the column's options have never held: the confirm has to
  // promote it, and only then switch the table onto the column
  await type("Group name", "waiting");
  await press("Group");
  await r.settle();

  const stored = (await vaultSchemaRead()) as unknown as Record<
    string,
    Record<string, { options?: SelectOption[] }>
  >;
  assert.ok(
    stored.task?.status?.options?.some((o) => o.value === "waiting"),
    "the promoted group name never reached the column's options"
  );
  const sections = r.all("tbody tr.db-group-tr");
  assert.ok(sections.length > 0, "the table never started grouping by the promoted column");
  assert.ok(
    sections.some((tr) => (tr.textContent ?? "").includes("waiting")),
    "the table regrouped without a section for the group the drop just made"
  );
  // the app's rows are not this file's rows: anything appended after this
  // test starts from the pane harness's own paths, not the task database's
  mountedPaths = [];
});
