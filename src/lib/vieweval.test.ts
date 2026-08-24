import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSavedView,
  savedViewPref,
  viewColumns,
  viewModel,
  viewOrderedRows,
  viewRows,
  VIEW_EVAL_SCHEMA,
} from "./vieweval.ts";
import type { NoteMeta, PropSchema, SavedView } from "./types.ts";

function note(title: string, props: Record<string, unknown>, folder = ""): NoteMeta {
  return {
    path: `${folder ? `${folder}/` : ""}${title}.md`,
    stem: title,
    title,
    folder,
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const TASK_SCHEMA: Record<string, PropSchema> = {
  status: {
    options: [
      { value: "doing", color: "blue" },
      { value: "todo", color: "grey" },
    ],
  },
  due: { kind: "date", options: [] },
  budget: { kind: "number", options: [], format: "euro" },
};

const TASKS = [
  note("Master", { type: "task", status: "todo", due: "2026-09-01", budget: "1200" }),
  note("Mix", { type: "task", status: "doing", due: "2026-08-01", budget: "300.5" }),
  note("Art", { type: "task", budget: "40" }),
  note("Label call", { type: "contact", status: "todo" }),
];

function view(extra: Partial<SavedView> = {}): SavedView {
  return { id: "v", name: "Open", db: "task", ...extra };
}

test("viewModel: columns come from schema and observed props, rollups fold in", () => {
  const schema: Record<string, PropSchema> = {
    ...TASK_SCHEMA,
    client: { kind: "relation", options: [], type: "client" },
    total: { kind: "rollup", options: [], relation: "client", prop: "fee", agg: "sum" },
  };
  const client = note("Acme", { type: "client", fee: "100" });
  const task = note("Master", { type: "task", client: "Acme", status: "todo" });
  const model = viewModel([task], schema, [task, client]);
  assert.ok(model.columns.includes("total"));
  assert.equal(model.dispNotes[0].props.total, "100");
  // a row the rollup found nothing for loses the key entirely, so it reads as
  // missing rather than as an empty cell
  const orphan = note("Solo", { type: "task" });
  const none = viewModel([orphan], schema, [orphan]);
  assert.equal("total" in none.dispNotes[0].props, false);
});

test("viewColumns: pin mode curates, database mode hides, order rides the pref", () => {
  const columns = ["status", "due", "budget"];
  assert.deepEqual(
    viewColumns(columns, { view: "table", hidden: ["budget"] }),
    ["status", "due"]
  );
  // a pin ignores the database's hidden set and paints its own list
  assert.deepEqual(
    viewColumns(columns, { view: "table", hidden: ["budget"] }, { pinMode: true, columnSelection: ["budget", "status"] }),
    ["budget", "status"]
  );
  assert.deepEqual(
    viewColumns(columns, { view: "table", col_order: ["budget"] }),
    ["budget", "status", "due"]
  );
});

test("viewRows: filter runs over derived rollup values, not the stored props", () => {
  const schema: Record<string, PropSchema> = {
    fee: { kind: "number", options: [] },
    client: { kind: "relation", options: [], type: "client" },
    total: { kind: "rollup", options: [], relation: "client", prop: "fee", agg: "sum" },
  };
  const rich = note("Rich", { type: "task", client: "Acme" });
  const poor = note("Poor", { type: "task", client: "Bono" });
  const all = [rich, poor, note("Acme", { type: "client", fee: "900" }), note("Bono", { type: "client", fee: "5" })];
  const model = viewModel([rich, poor], schema, all);
  // a rollup column is derived, never stored — a query can only match it
  // because the filter runs after the derivation
  const out = viewRows(model, schema, { query: "total:900" });
  assert.deepEqual(out.rows.map((n) => n.title), ["Rich"]);
});

test("viewOrderedRows: sort keys cascade, missing values trail in both directions", () => {
  const rows = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    sorts: [{ key: "due", dir: 1 }],
  }).rows;
  assert.deepEqual(rows.map((n) => n.title), ["Mix", "Master", "Art"]);
  const desc = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    sorts: [{ key: "due", dir: -1 }],
  }).rows;
  assert.deepEqual(desc.map((n) => n.title), ["Master", "Mix", "Art"]);
  // number keys compare by value, not by digit runs
  const byBudget = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    sorts: [{ key: "budget", dir: 1 }],
  }).rows;
  assert.deepEqual(byBudget.map((n) => n.title), ["Art", "Mix", "Master"]);
});

test("viewOrderedRows: rows tied on every key break on PATH, not on title", () => {
  // the two orders have to be told apart, or the tie-break is only asserted
  // where they coincide: these titles collate the opposite way to their
  // paths, so a title tie-break would fail here and a path one passes
  const tied = [
    note("Zephyr", { type: "task", status: "todo" }, "Archive"),
    note("Amber", { type: "task", status: "todo" }, "Backlog"),
  ];
  const byPath = viewOrderedRows(tied, TASK_SCHEMA, { sorts: [{ key: "status", dir: 1 }] }).rows;
  assert.deepEqual(byPath.map((n) => n.path), ["Archive/Zephyr.md", "Backlog/Amber.md"]);
  // and the order does not depend on how the rows arrived
  const reversed = viewOrderedRows([...tied].reverse(), TASK_SCHEMA, {
    sorts: [{ key: "status", dir: 1 }],
  }).rows;
  assert.deepEqual(reversed.map((n) => n.path), byPath.map((n) => n.path));
  // a DESC key still leaves its ties in ascending path order — the tie-break
  // is the total order's floor, not part of the key being flipped
  const desc = viewOrderedRows(tied, TASK_SCHEMA, { sorts: [{ key: "status", dir: -1 }] }).rows;
  assert.deepEqual(desc.map((n) => n.path), ["Archive/Zephyr.md", "Backlog/Amber.md"]);
});

test("viewOrderedRows: grouping sorts within sections, in schema option order", () => {
  const out = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    sorts: [{ key: "budget", dir: 1 }],
    tableGroup: "status",
  });
  assert.deepEqual(out.rows.map((n) => n.title), ["Mix", "Master", "Art"]);
  assert.deepEqual(
    out.rowGroups?.map((g) => [g.value, g.start, g.count]),
    [
      ["doing", 0, 1],
      ["todo", 1, 1],
      [null, 2, 1],
    ]
  );
});

test("savedViewPref: a pin's sorts never fall back to the database's", () => {
  const dbPref = { view: "table" as const, sorts: [{ key: "due", dir: 1 as const }] };
  assert.deepEqual(savedViewPref(view(), dbPref).sorts, []);
  assert.deepEqual(savedViewPref(view({ sort: { key: "budget", dir: -1 } }), dbPref).sorts, [
    { key: "budget", dir: -1 },
  ]);
});

test("evaluateSavedView: membership folds case, cells carry raw and painted values", () => {
  const out = evaluateSavedView(view({ query: "status:todo" }), TASKS, TASK_SCHEMA);
  assert.equal(out.schema, VIEW_EVAL_SCHEMA);
  assert.equal(out.total, 1);
  assert.deepEqual(out.rows.map((r) => r.title), ["Master"]);
  const cells = out.rows[0].cells;
  assert.equal(cells.due.raw, "2026-09-01");
  assert.equal(cells.due.display, "Sep 1, 2026");
  assert.equal(cells.budget.display, "1.200 €");
  // an untyped note of another database never enters the view
  assert.equal(out.rows.some((r) => r.title === "Label call"), false);
});

test("evaluateSavedView: groups carry the section labels the table draws", () => {
  const out = evaluateSavedView(view({ table_group_by: "status" }), TASKS, TASK_SCHEMA);
  assert.deepEqual(out.groups.map((g) => [g.label, g.count]), [
    ["doing", 1],
    ["todo", 1],
    ["No status", 1],
  ]);
  assert.equal(out.group_by, "status");
  // the flat row list stays the concatenation of the sections
  assert.deepEqual(
    out.groups.flatMap((g) => g.rows.map((r) => r.title)),
    out.rows.map((r) => r.title)
  );
});

test("evaluateSavedView: date filters compare against the day passed in", () => {
  const q = view({ query: "due < 0d" });
  assert.equal(evaluateSavedView(q, TASKS, TASK_SCHEMA, { today: "2026-08-15" }).total, 1);
  assert.equal(evaluateSavedView(q, TASKS, TASK_SCHEMA, { today: "2026-07-01" }).total, 0);
});

test("viewOrderedRows: a collapsed section paints no rows but still counts them", () => {
  const out = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    tableGroup: "status",
    collapsedGroups: ["doing"],
  });
  assert.deepEqual(out.rows.map((n) => n.title), ["Master", "Art"], "the folded section is gone");
  assert.deepEqual(
    out.rowGroups?.map((g) => [g.value, g.start, g.count, g.collapsed]),
    [
      ["doing", 0, 1, true],
      // the next section starts where the folded header sits: one index,
      // two headers before the row that lives there
      ["todo", 0, 1, false],
      [null, 1, 1, false],
    ]
  );
  assert.deepEqual(
    out.fullRows.map((n) => n.title),
    ["Mix", "Master", "Art"],
    "the fold is a view state: the footer tally still sees every row"
  );
});

test("viewOrderedRows: the valueless section folds under the empty-string key", () => {
  const out = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    tableGroup: "status",
    collapsedGroups: [""],
  });
  assert.deepEqual(out.rows.map((n) => n.title), ["Mix", "Master"]);
  const last = out.rowGroups?.[(out.rowGroups?.length ?? 0) - 1];
  assert.equal(last?.collapsed, true);
  assert.equal(last?.start, 2, "a trailing fold's header sits past the last row");
});

test("viewOrderedRows: a hand order re-sections the table, schema order is the default", () => {
  const plain = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, { tableGroup: "status" });
  assert.deepEqual(plain.rowGroups?.map((g) => g.value), ["doing", "todo", null]);
  const dragged = viewOrderedRows(TASKS.slice(0, 3), TASK_SCHEMA, {
    tableGroup: "status",
    groupOrder: ["", "todo"],
  });
  assert.deepEqual(dragged.rowGroups?.map((g) => g.value), [null, "todo", "doing"]);
  assert.deepEqual(dragged.rows.map((n) => n.title), ["Art", "Master", "Mix"]);
  assert.deepEqual(
    dragged.rowGroups?.map((g) => g.start),
    [0, 1, 2],
    "starts follow the painted order, not the schema's"
  );
});

test("viewRows: a headless reader reports the sections in the pane's hand order", () => {
  const tasks = TASKS.slice(0, 3);
  const model = viewModel(tasks, TASK_SCHEMA, tasks);
  const schemaOrder = viewRows({ ...model, pref: { view: "table", table_group_by: "status" } }, TASK_SCHEMA);
  assert.deepEqual(schemaOrder.rowGroups?.map((g) => g.value), ["doing", "todo", null]);

  // the pane persists a dragged section order on the pref; a reader of the
  // same view walks the same sections in the same sequence
  const dragged = viewRows(
    { ...model, pref: { view: "table", table_group_by: "status", group_order: ["", "todo"] } },
    TASK_SCHEMA
  );
  assert.deepEqual(dragged.rowGroups?.map((g) => g.value), [null, "todo", "doing"]);
  assert.deepEqual(dragged.rows.map((n) => n.title), ["Art", "Master", "Mix"]);

  // folds are the pane's own: a reader answers for every row the view holds
  const folded = viewRows(
    { ...model, pref: { view: "table", table_group_by: "status", collapsed_groups: ["doing"] } },
    TASK_SCHEMA
  );
  assert.deepEqual(folded.rows.map((n) => n.title), ["Mix", "Master", "Art"]);
});
