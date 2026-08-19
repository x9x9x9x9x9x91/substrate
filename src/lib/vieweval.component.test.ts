/** The same-eyes guarantee, asserted end to end.
 *
 *  A headless reader of a saved view is only worth having if what it reports
 *  IS what the table paints. Both sides now call one evaluator, but "both
 *  call it" is a claim about wiring, and wiring is exactly what drifts. So
 *  this renders the real database pane over a fixture vault, scrapes the
 *  painted table out of the DOM — row order, section headers, every cell as
 *  a reader sees it — and asserts it against the evaluator's own payload.
 *
 *  A change that made the pane paint something the evaluator doesn't report
 *  (or the reverse) fails here, whichever side moved. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, type FunctionComponent } from "react";
import { mockBackend, renderComponent, type Rendered } from "./componentHarness.ts";
import { evaluateSavedView, savedViewPref } from "./vieweval.ts";
import type { NoteMeta, PropSchema, SavedView, ViewPref } from "./types.ts";

function note(title: string, props: Record<string, unknown>, folder = "Tasks"): NoteMeta {
  return {
    path: `${folder}/${title}.md`,
    stem: title,
    title,
    folder,
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const TYPE_SCHEMA: Record<string, PropSchema> = {
  status: {
    options: [
      { value: "doing", color: "blue" },
      { value: "todo", color: "grey" },
    ],
  },
  due: { options: [], kind: "date" },
  budget: { options: [], kind: "number", format: "euro" },
  owner: { options: [], kind: "text" },
  // the two kinds whose cell is a chip row rather than a string: the
  // evaluator reports them as `values`, and nothing asserted that list
  // against the chips until the case below
  format: {
    kind: "multi",
    options: [
      { value: "Vinyl", color: "violet" },
      { value: "Digital", color: "blue" },
      { value: "Tape", color: "teal" },
    ],
  },
  contact: { kind: "relation", options: [] },
};

const NOTES: NoteMeta[] = [
  // `format` and `contact` cover every shape a chip cell arrives in: a
  // stored LIST, a single scalar (one chip), a value with no schema option
  // (it still pills, in gray), and the prop absent altogether (no chips)
  note("Master the EP", { type: "task", status: "todo", due: "2026-09-01", budget: "1200", owner: "Sam", format: ["Vinyl", "Digital"], contact: ["Gero", "Noa"] }),
  note("Mix vocals", { type: "task", status: "doing", due: "2026-08-01", budget: "300.5", owner: "Ada", format: "Tape", contact: "Noa" }),
  note("Book the room", { type: "task", status: "todo", due: "2026-08-20", budget: "80", owner: "Sam", format: ["Cassingle"] }),
  note("Sleeve art", { type: "task", budget: "40", owner: "Rob" }),
  note("Skip me", { type: "task", status: "done", budget: "9" }),
  note("Not a task", { type: "contact", status: "todo" }, "People"),
];

/** The pane is handed one database's rows by the shell around it; deciding
    membership is not its job. The evaluator has no shell, so it folds `type`
    itself — and the stray contact above is what proves the two agree: it must
    be absent from both sides for the assertions to line up. */
const DB_NOTES = NOTES.filter((n) => String(n.props.type).toLowerCase() === "task");

/** Everything the pane needs that this test does not exercise: callbacks that
    must exist, seeds that must be inert. Kept in one place so a new prop
    shows up as a type error here rather than as a crash mid-render. */
function paneProps(view: SavedView, dbPref?: ViewPref) {
  return {
    dbType: "task",
    notes: DB_NOTES,
    allNotes: NOTES,
    // composed by the one function the shell around the pane also calls —
    // handing the pane a hand-built pref here would test a spelling that
    // exists nowhere else
    pref: savedViewPref(view, dbPref),
    typeSchema: TYPE_SCHEMA,
    schema: { task: TYPE_SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: async () => DB_NOTES[0],
    dbTypes: ["task"],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    numberLocale: "de-DE" as const,
    onPrefChange: () => {},
    onOpenNote: () => {},
    onNoteMenu: () => {},
    onTrashNotes: () => {},
    onMutated: () => {},
    initialQuery: view.query,
    initialColumns: view.columns,
    // a pin is a curated view: providing this is what puts the pane in pin
    // mode, the mode a saved view is read in
    onColumnsChange: () => {},
    onSaveView: () => {},
    savedViews: [view],
    activeViewId: view.id,
    onOpenView: () => {},
    onViewMenu: () => {},
    pinKeys: {},
    onRenameDb: () => {},
    onDeleteDb: () => {},
    onRenameProp: () => {},
    onRemoveProp: () => {},
  };
}

/** One cell's chips, or null when the cell paints plain text. A multi or
    relation cell is a row of pills, not a string, so its parity has to be
    checked value by value — the joined text alone would pass a cell that
    painted one chip reading "Vinyl, Digital". */
function chipsOf(td: Element): string[] | null {
  const pills = td.querySelector(".multi-pills");
  if (!pills) return null;
  return Array.from(pills.children).map((el) => el.textContent ?? "");
}

/** The painted table, read back the way a person reads it. */
function painted(r: Rendered): {
  columns: string[];
  rows: { title: string; cells: string[]; chips: (string[] | null)[] }[];
  groups: { label: string; count: number }[];
} {
  // the header also paints the sort direction into its label; the arrow is a
  // control, not part of the column's identity
  const columns = r
    .all("th .db-th-label")
    .map((el) => (el.textContent ?? "").replace(/[↑↓]/g, "").trim());
  const rows = r
    .all("tbody tr")
    .filter((tr) => tr.querySelector("td[data-fc='0']"))
    .map((tr) => {
      const tds = Array.from(tr.querySelectorAll("td[data-fc]")).filter(
        (td) => td.getAttribute("data-fc") !== "0"
      );
      return {
        title: tr.querySelector("td[data-fc='0'] .db-title-txt")?.textContent ?? "",
        // a chip row carries no separator in the DOM; the evaluator's
        // `display` for the same cell is the values joined, so read the
        // chips back as that same string and compare like with like
        cells: tds.map((td) => {
          const chips = chipsOf(td);
          return chips ? chips.join(", ") : (td.querySelector(".db-cell-txt")?.textContent ?? "");
        }),
        chips: tds.map(chipsOf),
      };
    });
  const groups = r.all(".db-group-head").map((el) => ({
    label: el.querySelector(".db-group-label")?.textContent ?? "",
    count: Number(el.querySelector(".db-group-count")?.textContent ?? "0"),
  }));
  return { columns, rows, groups };
}

/** The evaluator's payload in the same shape, so a mismatch reads as a diff
    of what a person would see rather than of two unrelated structures. */
function evaluated(view: SavedView, dbPref?: ViewPref) {
  const out = evaluateSavedView(view, NOTES, TYPE_SCHEMA, { locale: "de-DE", pref: dbPref });
  return {
    columns: out.columns.map((c) => c.charAt(0).toUpperCase() + c.slice(1)),
    rows: out.rows.map((row) => ({
      title: row.title,
      cells: out.columns.map((c) => row.cells[c].display),
      // `values` is set for exactly the chip kinds; a cell with none paints
      // no `.multi-pills` at all, which is the null on the painted side
      chips: out.columns.map((c) => row.cells[c].values ?? null),
    })),
    groups: out.groups.map((g) => ({ label: g.label, count: g.count })),
  };
}

/** A database somebody has curated: columns dragged into a new order and two
    of them hidden from the table. None of it belongs to a PIN — a pin is a
    capture of the columns it was saved with, in the order it was saved with
    — so the cases carrying this pref are the ones that would catch the
    database's curation leaking into a pin. */
const CURATED_DB: ViewPref = {
  view: "table",
  col_order: ["budget", "owner", "due", "status"],
  hidden: ["due"],
  hidden_per_layout: { table: ["budget"], list: [] },
};

const CASES: {
  name: string;
  view: SavedView;
  rows: number;
  groups: number;
  dbPref?: ViewPref;
  /** The painted column headers, when the point of the case is their order. */
  columns?: string[];
  /** The painted row titles, when the point of the case is their order. */
  titles?: string[];
  /** The chips each row's cells paint, when the point of the case is that
      the evaluator's `values` and the pane's pills are one list. */
  chips?: (string[] | null)[][];
}[] = [
  {
    rows: 2,
    groups: 0,
    name: "a filtered, sorted view",
    view: {
      id: "open",
      name: "Open",
      db: "task",
      query: "status:todo",
      sorts: [{ key: "due", dir: 1 }],
      columns: ["status", "due", "budget"],
    },
  },
  {
    rows: 5,
    // doing · todo · done · the null section last
    groups: 4,
    name: "a grouped view",
    view: {
      id: "by-status",
      name: "By status",
      db: "task",
      table_group_by: "status",
      sorts: [{ key: "budget", dir: -1 }],
      columns: ["status", "budget", "owner"],
    },
  },
  {
    rows: 5,
    groups: 0,
    name: "an unsorted view resting on title order",
    view: { id: "all", name: "All", db: "task" },
  },
  {
    rows: 5,
    groups: 0,
    name: "a pin over a database whose columns were dragged and hidden",
    view: { id: "curated", name: "Curated", db: "task", columns: ["status", "due", "budget"] },
    dbPref: CURATED_DB,
    // the pin's own three columns, in the pin's own order: the database's
    // drag order and its hidden sets are its curation, not the pin's
    columns: ["Status", "Due", "Budget"],
  },
  {
    rows: 5,
    groups: 0,
    name: "a sort with a tie run, which path settles rather than input order",
    // Sam owns two of these rows. The pane is handed them in the index's
    // order (Master the EP first), a file reader in path order (Book the
    // room first) — so a tie run left to the input would paint one order and
    // print the other. Both must land on path.
    view: { id: "by-owner", name: "By owner", db: "task", sorts: [{ key: "owner", dir: 1 }], columns: ["owner", "budget"] },
    titles: ["Mix vocals", "Sleeve art", "Book the room", "Master the EP", "Skip me"],
  },
  {
    rows: 5,
    groups: 0,
    // the evaluator answers these two columns with a `values` LIST beside the
    // joined `display`, and the pane answers them with a row of chips. The
    // joined string alone cannot tell "Vinyl" + "Digital" from one chip
    // reading "Vinyl, Digital", so the chips are compared value by value.
    name: "a view whose cells are chip rows, not strings",
    // `owner` and `budget` ride along as the plain-text controls: chip
    // columns and string columns in one table, and the nulls in each row
    // below are the painted proof that a text cell grows no `.multi-pills`
    view: { id: "chips", name: "Chips", db: "task", columns: ["owner", "budget", "format", "contact"], sorts: [{ key: "owner", dir: 1 }] },
    columns: ["Owner", "Budget", "Format", "Contact"],
    chips: [
      // Mix vocals: a scalar is one chip on both sides
      [null, null, ["Tape"], ["Noa"]],
      // Sleeve art: the props are absent — an empty chip row, not a chip
      [null, null, [], []],
      // Book the room: a value with no schema option still chips (gray), and
      // a relation the note never set stays empty next to it
      [null, null, ["Cassingle"], []],
      // Master the EP: a stored list, in stored order, both kinds
      [null, null, ["Vinyl", "Digital"], ["Gero", "Noa"]],
      [null, null, [], []],
    ],
  },
];

for (const c of CASES) {
  test(`same eyes: ${c.name} paints exactly what the evaluator reports`, async (t) => {
    await mockBackend();
    const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
    const r = await renderComponent(
      t,
      h(DatabasePane as unknown as FunctionComponent<Record<string, unknown>>, paneProps(c.view, c.dbPref))
    );
    await r.settle();
    const seen = painted(r);
    const want = evaluated(c.view, c.dbPref);
    // what BOTH sides must show, so a case cannot pass by having the two
    // readers agree on the wrong thing
    if (c.columns) assert.deepEqual(seen.columns, c.columns);
    if (c.titles) assert.deepEqual(seen.rows.map((row) => row.title), c.titles);
    if (c.chips) assert.deepEqual(seen.rows.map((row) => row.chips), c.chips);
    // two empty tables are trivially identical — pin what this view actually
    // shows, so a fixture or a pipeline that stopped producing rows fails here
    assert.equal(seen.rows.length, c.rows);
    assert.equal(seen.groups.length, c.groups);
    assert.ok(seen.rows.every((row) => row.cells.some((cell) => cell !== "")));
    assert.deepEqual(seen.rows.map((row) => row.title), want.rows.map((row) => row.title));
    assert.deepEqual(seen.columns, want.columns);
    assert.deepEqual(seen.rows, want.rows);
    assert.deepEqual(seen.groups, want.groups);
  });
}
