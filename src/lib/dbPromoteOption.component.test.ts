/** "Add “x” to options" on a real database table, rendered through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    Picking that row writes twice — the option into the database's schema, the
    value into the note — and the two used to fire independently. A refused
    schema write still let the value land, where it rendered as an extra the
    column knew nothing about; and when both landed, one ⌘Z took the value back
    and left the new option in the schema for good.

    What has to hold, and none of it is reachable from tsc: the option write
    goes FIRST and the value only follows if it landed, a failure on either
    side leaves the vault exactly as it stood, and the pair records ONE undo
    entry rather than two. The bulk bar's picker rides the same door, so it is
    driven here too. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent, type Rendered } from "./componentHarness.ts";
import { addOptionAndWriteUndoable } from "./undoschema.ts";
import type { UndoRecorder } from "./undoprops.ts";
import type {
  NoteMeta,
  PropKind,
  PropSchema,
  PropValue,
  SelectOption,
  SetPropResult,
} from "./types.ts";
import type { UndoEntry } from "./undo.ts";

const DB = "Task";
const COL = "Stage";

const SCHEMA = {
  [COL]: { options: [{ value: "live" }] },
} as unknown as Record<string, PropSchema>;

function row(title: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: DB, [COL]: "live" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [row("Ivo"), row("Vesna")];

/** Everything the pane needs, with what these tests don't drive inert — built
    loosely on purpose (same reasoning as the rename harness): the pane takes
    some thirty callbacks, and naming them all would pin the prop list rather
    than the behaviour. */
function paneProps(over: Record<string, unknown>): Record<string, unknown> {
  return {
    dbType: DB,
    notes: NOTES,
    allNotes: NOTES,
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

type Pending = Omit<UndoEntry, "id"> & { id?: number };

/** Everything the two writes did, in the order they did it: `schema` holds the
    option lists as they were stored, `props` the property writes the pane's
    own write door made, and `undo` whatever the action recorded. */
interface Writes {
  schema: string[][];
  /** the kind each schema write stored the options under */
  kinds: (PropKind | null)[];
  props: [string, string, PropValue][];
  undo: Pending[];
  /** stored options, as the vault would answer a read */
  options: SelectOption[];
}

function writes(): Writes {
  return { schema: [], kinds: [], props: [], undo: [], options: [{ value: "live" }] };
}

/** A property writer standing in for the vault: it remembers priors so undo
    has something real to put back, and can be told to refuse — every note, or
    one named note, which is the partly-landed bulk the toast counts. */
function propWriter(w: Writes, refuse?: string, refuseOnly?: string) {
  const stored = new Map<string, PropValue>();
  for (const n of NOTES) stored.set(`${n.path}::${COL}`, "live");
  return (path: string, key: string, value: PropValue): Promise<SetPropResult> => {
    if (refuse && (refuseOnly === undefined || path === refuseOnly))
      return Promise.reject(new Error(refuse));
    const at = `${path}::${key}`;
    const prior = stored.get(at) ?? null;
    stored.set(at, value);
    w.props.push([path, key, value]);
    return Promise.resolve({
      meta: { ...row(path.replace(/\.md$/, "")), props: { type: DB, [key]: value } },
      prior,
    } as unknown as SetPropResult);
  };
}

/** The promote door App hands the pane, over the fake schema store. The real
    one writes the kind beside the options on BOTH sides — restoring an
    optionless column without its kind is what deletes the property — so this
    stand-in records what each direction asked for. */
function promoteOption(w: Writes, record: UndoRecorder, refuse?: string) {
  return (
    _prop: string,
    add: {
      before: SelectOption[];
      after: SelectOption[];
      kind: PropKind | null;
      priorKind: PropKind | null;
    },
    writeValue: (record: UndoRecorder) => Promise<void>
  ) =>
    void addOptionAndWriteUndoable({
      store: {
        before: { options: add.before, kind: add.priorKind },
        after: { options: add.after, kind: add.kind },
        write: (state) => {
          if (refuse) return Promise.reject(new Error(refuse));
          w.schema.push(state.options.map((o) => o.value));
          w.kinds.push(state.kind);
          w.options = state.options;
          return Promise.resolve();
        },
        read: () => Promise.resolve(w.options),
      },
      writeValue,
      record,
    }).catch(() => {
      // the pane's own toast reports the refusal; the test reads the writes
    });
}

function paneWith(w: Writes, over: Record<string, unknown> = {}): Record<string, unknown> {
  return paneProps({
    writeProp: propWriter(w),
    undo: { record: (e: Pending) => w.undo.push(e), runById: () => {} },
    onPromoteOption: promoteOption(w, (e) => w.undo.push(e)),
    ...over,
  });
}

async function typeInto(el: Element, value: string): Promise<void> {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The menus are portalled to the body, so their rows are not inside the
    render's container — find the row by the words it shows. */
function menuRow(text: string): Element {
  const found = [...document.querySelectorAll(".selmenu-item, .colmenu .dots-item")].find((el) =>
    (el.textContent ?? "").includes(text)
  );
  assert.ok(found, `no menu row reading “${text}”`);
  return found;
}

/** The picker itself, standing in for any surface that mounts one — the note
    pane's property chip rides exactly this contract. */
async function picker(
  t: Parameters<typeof renderComponent>[0],
  over: Record<string, unknown>
): Promise<Rendered> {
  const SelectMenu = (await import("../components/SelectMenu.tsx")).default;
  return renderComponent(
    t,
    h(SelectMenu as never, {
      anchor: { left: 0, top: 0, bottom: 20 },
      value: "live",
      options: [{ value: "live" }],
      used: [],
      canEditSchema: true,
      description: "where the work stands",
      onCommit: () => {},
      onSaveSchema: () => {},
      onClose: () => {},
      ...over,
    } as never)
  );
}

function buttonReading(r: Rendered, label: string): Element {
  const found = r.all("button").find((el) => (el.textContent ?? "").trim() === label);
  assert.ok(found, `no button reading “${label}”`);
  return found;
}

async function clickRow(r: Rendered, text: string): Promise<void> {
  await act(async () => {
    menuRow(text).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await r.settle();
}

/** the Stage cells — the Name column and the trailing spacer share the class */
const VALUE_CELLS = "td.db-cell:not(.db-title):not(.db-add-cell)";

/** Open the first Stage cell's editor and type a value the column has never
    seen — which is what puts the promote row on the list. */
async function typeNewValue(r: Rendered, value: string): Promise<void> {
  await r.click(r.all(VALUE_CELLS)[0]);
  const input = document.querySelector(".selmenu-input");
  assert.ok(input, "the cell opened its editor");
  await typeInto(input, value);
  await r.settle();
}

test("promoting from a cell writes the option first, then the value, as ONE undo step", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const w = writes();
  const r = await renderComponent(t, h(DatabasePane as never, paneWith(w) as never));

  await typeNewValue(r, "shipped");
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(w.schema, [["live", "shipped"]], "the option went into the schema");
  assert.deepEqual(
    w.props,
    [["Ivo.md", COL, "shipped"]],
    "and the value into the note, once the option was stored"
  );
  assert.equal(w.undo.length, 1, "the pair records exactly ONE undo entry, not two");

  await act(async () => {
    await w.undo[0].undo();
  });
  assert.deepEqual(
    w.props[w.props.length - 1],
    ["Ivo.md", COL, "live"],
    "the single undo puts the value back"
  );
  assert.deepEqual(
    w.schema[w.schema.length - 1],
    ["live"],
    "and takes the option it created back out of the schema"
  );
});

test("a refused option write leaves the cell alone", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const w = writes();
  const props = paneWith(w, {
    onPromoteOption: promoteOption(w, (e) => w.undo.push(e), "schema is read-only"),
  });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  await typeNewValue(r, "shipped");
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(w.props, [], "no value lands behind an option the vault refused");
  assert.deepEqual(w.schema, [], "and nothing was stored");
  assert.equal(w.undo.length, 0, "so there is nothing to take back");
});

test("a refused value write takes the option back out with it", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const w = writes();
  const props = paneWith(w, { writeProp: propWriter(w, "the note is gone") });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  await typeNewValue(r, "shipped");
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(w.props, [], "the value never landed");
  assert.deepEqual(
    w.schema,
    [["live", "shipped"], ["live"]],
    "so the option it was meant to fill is rolled back out"
  );
  assert.equal(w.undo.length, 0, "and the half-write is not offered as an undo");
});

test("the promote row is not offered where the two writes cannot be paired", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const w = writes();
  const props = paneWith(w, { onPromoteOption: undefined });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  await typeNewValue(r, "shipped");
  const rows = [...document.querySelectorAll(".selmenu-item")].map((el) => el.textContent ?? "");
  assert.ok(
    rows.some((t_) => t_.includes("Use “shipped”")),
    "the plain free-text row is still there"
  );
  assert.ok(
    !rows.some((t_) => t_.includes("to options")),
    "but an option nothing would put a value into is not offered"
  );
});

/** Select every row the way the table's own gesture does, open the bulk bar's
    editor for the Stage column and type a value the column has never seen. */
async function typeNewBulkValue(r: Rendered, value: string): Promise<void> {
  for (const cell of r.all(VALUE_CELLS)) {
    await act(async () => {
      cell.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
      );
    });
  }
  await r.settle();
  assert.match(r.text(), /2 selected/, "the bulk bar is up");

  await r.click(buttonReading(r, "Set property…"));
  await act(async () => {
    menuRow(COL).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await r.settle();
  const input = document.querySelector(".selmenu-input");
  assert.ok(input, "the bulk editor opened on the column");
  await typeInto(input, value);
  await r.settle();
}

test("the bulk bar's picker promotes through the same paired write", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const w = writes();
  const r = await renderComponent(t, h(DatabasePane as never, paneWith(w) as never));

  await typeNewBulkValue(r, "shipped");
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(w.schema, [["live", "shipped"]], "one option write");
  assert.deepEqual(
    w.props.map(([p]) => p).sort(),
    ["Ivo.md", "Vesna.md"],
    "the value went to every selected note"
  );
  assert.equal(w.undo.length, 1, "and the whole thing is ONE undo entry");
});

test("the picker hands the promote to one door, never to the old write pair", async (t) => {
  const promoted: unknown[] = [];
  const saved: unknown[] = [];
  const committed: string[] = [];
  const r = await picker(t, {
    onPromote: (add: unknown) => promoted.push(add),
    onSaveSchema: (opts: unknown) => saved.push(opts),
    onCommit: (v: string) => committed.push(v),
  });

  await typeInto(document.querySelector(".selmenu-input")!, "shipped");
  await r.settle();
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(
    promoted,
    [
      {
        value: "shipped",
        before: [{ value: "live" }],
        after: [{ value: "live" }, { value: "shipped" }],
        kind: null,
        priorKind: null,
        description: "where the work stands",
      },
    ],
    "the whole payload goes out once, description included"
  );
  assert.deepEqual(saved, [], "the schema is no longer written on its own…");
  assert.deepEqual(committed, [], "…nor the value beside it");
});

test("promoting on a multi keeps the property a multi", async (t) => {
  const promoted: { kind: string | null }[] = [];
  const r = await picker(t, {
    kind: "multi",
    values: ["live"],
    onToggle: () => {},
    onPromote: (add: { kind: string | null }) => promoted.push(add),
  });

  await typeInto(document.querySelector(".selmenu-input")!, "shipped");
  await r.settle();
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(
    promoted.map((p) => p.kind),
    ["multi"],
    "an inline promote must not quietly turn a multi into a select"
  );
});


test("the picker carries the kind the column already had, not just the one it stores", async (t) => {
  // undo puts the options back beside this kind. Drop it and a column that
  // had no options — every explicit kind but multi — comes back empty AND
  // kindless, which is how the vault spells "no such property".
  const promoted: { kind: string | null; priorKind: string | null }[] = [];
  const r = await picker(t, {
    kind: "number",
    value: "",
    options: [],
    onPromote: (add: { kind: string | null; priorKind: string | null }) => promoted.push(add),
  });

  await typeInto(document.querySelector(".selmenu-input")!, "many");
  await r.settle();
  await clickRow(r, "Add “many” to options");

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].priorKind, "number", "the kind undo has to put back rides along");
  assert.equal(promoted[0].kind, null, "while the promote itself stores a plain select");
});

test("a bulk promote only some notes take keeps the option and still records one entry", async (t) => {
  // the shape the atomic pair exists for: the option is real (a value did land
  // in it), the notes that refused are the caller's to report, and ⌘Z has to
  // take back exactly what landed — option included
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const w = writes();
  const said: string[] = [];
  const props = paneWith(w, {
    writeProp: propWriter(w, "the note is sealed", "Vesna.md"),
    onToast: (msg: string) => said.push(msg),
  });
  const r = await renderComponent(t, h(DatabasePane as never, props as never));

  await typeNewBulkValue(r, "shipped");
  await clickRow(r, "Add “shipped” to options");

  assert.deepEqual(w.schema, [["live", "shipped"]], "the option stays: a value landed in it");
  assert.deepEqual(
    w.props.map(([p]) => p),
    ["Ivo.md"],
    "only the note that took it was written"
  );
  assert.ok(
    said.some((m) => /1 of 2/.test(m)),
    `the refusal is reported — said ${JSON.stringify(said)}`
  );
  assert.equal(w.undo.length, 1, "and what landed is ONE takeable-back action");

  await act(async () => {
    await w.undo[0].undo();
  });
  assert.deepEqual(
    w.props[w.props.length - 1],
    ["Ivo.md", COL, "live"],
    "undo puts the value that landed back"
  );
  assert.deepEqual(
    w.schema[w.schema.length - 1],
    ["live"],
    "and takes the option out with it — it has nothing left in it"
  );
});

/* The note pane's property chip is the third surface on this door, and until
   now it was covered by the sentence above the `picker` helper rather than by
   a render. The pane writes through the mock backend rather than a `writeProp`
   prop, so this one stages a real note and reads the vault back. */

const CHIP_DB = "Component Test Chip";
const CHIP_COL = "Stage";
/** the staged note the chip tests open */
let chipNote: NoteMeta;

before(async () => {
  await mockBackend();
  const { vaultCreate, vaultSchemaSet, vaultSetProp } = await import("./ipc.ts");
  await vaultSchemaSet(CHIP_DB, CHIP_COL, [{ value: "live" }]);
  chipNote = await vaultCreate("Chip Promote", CHIP_DB, undefined, undefined, "body\n");
  // the pane reads the database off the note's own `type`, not off its folder
  await vaultSetProp(chipNote.path, "type", CHIP_DB);
  await vaultSetProp(chipNote.path, CHIP_COL, "live");
});

/** Mount the note pane on the staged note, with everything this file does not
    drive inert — same loose shape as the database pane's props above. */
async function notePane(
  t: Parameters<typeof renderComponent>[0],
  over: Record<string, unknown>
): Promise<Rendered> {
  const { vaultRead } = await import("./ipc.ts");
  const { default: NotePane } = await import("../components/NotePane.tsx");
  const note = await vaultRead(chipNote.path);
  return renderComponent(
    t,
    h(NotePane as never, {
      // the staged `type` prop landed after the note was created, so the meta
      // this mounts on carries what the note holds now
      meta: { ...chipNote, props: note.props },
      schema: { [CHIP_DB]: { [CHIP_COL]: { options: [{ value: "live" }] } } },
      usedValues: () => [],
      vaultEpoch: 0,
      onSaveSchema: () => {},
      relationCandidates: () => [],
      onCreateEntry: () => Promise.reject(new Error("not used")),
      dbTypes: [CHIP_DB],
      onFollowLink: () => {},
      noteTitles: [],
      linkedNoteBody: () => Promise.resolve(null),
      onOpenNote: () => {},
      onRenamed: () => {},
      onMutated: () => {},
      editorFocusRef: { current: null },
      ...over,
    } as never)
  );
}

/** Open the Stage chip's picker and type a value the column has never seen. */
async function typeNewChipValue(r: Rendered, value: string): Promise<void> {
  const chip = r.all("button.chip-primary").find((b) => {
    const row = b.closest(".chip");
    return (row?.textContent ?? "").includes(CHIP_COL);
  });
  assert.ok(chip, "the note pane painted a Stage chip");
  await r.click(chip);
  const input = document.querySelector(".selmenu-input");
  assert.ok(input, "the chip opened its picker");
  await typeInto(input, value);
  await r.settle();
}

test("the note pane's chip promotes through the same paired write", async (t) => {
  const { vaultRead } = await import("./ipc.ts");
  const w = writes();
  const seen: [string, string][] = [];
  const r = await notePane(t, {
    onPromoteOption: (
      dbType: string,
      prop: string,
      add: Parameters<ReturnType<typeof promoteOption>>[1],
      writeValue: (record: UndoRecorder) => Promise<void>
    ) => {
      seen.push([dbType, prop]);
      promoteOption(w, (e) => w.undo.push(e))("", add, writeValue);
    },
  });

  await typeNewChipValue(r, "shipped");
  await clickRow(r, "Add “shipped” to options");
  await r.settle();

  assert.deepEqual(seen, [[CHIP_DB, CHIP_COL]], "the chip names its own database and column");
  assert.deepEqual(w.schema, [["live", "shipped"]], "the option went in first");
  assert.equal(
    (await vaultRead(chipNote.path)).props[CHIP_COL],
    "shipped",
    "and the value followed onto the note"
  );
  assert.equal(w.undo.length, 1, "as ONE takeable-back action");

  await act(async () => {
    await w.undo[0].undo();
  });
  assert.equal(
    (await vaultRead(chipNote.path)).props[CHIP_COL],
    "live",
    "one undo puts the value back"
  );
  assert.deepEqual(w.schema[w.schema.length - 1], ["live"], "and takes the option out with it");
});

test("a chip promote the vault refuses leaves the note alone", async (t) => {
  const { vaultRead } = await import("./ipc.ts");
  const w = writes();
  const r = await notePane(t, {
    onPromoteOption: (
      _dbType: string,
      _prop: string,
      add: Parameters<ReturnType<typeof promoteOption>>[1],
      writeValue: (record: UndoRecorder) => Promise<void>
    ) => promoteOption(w, (e) => w.undo.push(e), "schema is read-only")("", add, writeValue),
  });

  await typeNewChipValue(r, "held");
  await clickRow(r, "Add “held” to options");
  await r.settle();

  assert.deepEqual(w.schema, [], "nothing was stored");
  assert.equal(
    (await vaultRead(chipNote.path)).props[CHIP_COL],
    "live",
    "so no value landed behind an option the vault refused"
  );
  assert.equal(w.undo.length, 0);
});
