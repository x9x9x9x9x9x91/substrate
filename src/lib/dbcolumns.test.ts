import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardGroupBy,
  canonicalColumn,
  canonicalColumnRecord,
  canonicalViewPref,
  dbColumns,
  effectiveColumns,
  hiddenForLayout,
  orderedColumns,
} from "./dbcolumns.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import type { NoteMeta } from "./types.ts";

function note(props: Record<string, unknown>): NoteMeta {
  return {
    path: "Inbox/x.md",
    stem: "x",
    title: "x",
    folder: "Inbox",
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

test("schema props become columns even with zero values in notes (SUB-43)", () => {
  const cols = dbColumns([], { author: { options: [], kind: "text" }, read: { options: [], kind: "date" } });
  assert.deepEqual(cols, ["author", "read"]);
});

test("schema ∪ note props, type/title excluded, known props lead", () => {
  const cols = dbColumns(
    [note({ type: "release", title: "x", status: "live", mood: "blue" })],
    { status: { options: [{ value: "live" }] }, released: { options: [], kind: "date" } }
  );
  // status leads via COLUMN_ORDER; the rest follow alphabetically
  assert.deepEqual(cols, ["status", "mood", "released"]);
});

test("a prop removed from the schema stays a column while notes carry values", () => {
  const cols = dbColumns([note({ status: "live" })], {});
  assert.deepEqual(cols, ["status"]);
});

test("schema and note keys fold to one column with observed casing (SUB-728)", () => {
  const notes = [note({ type: "task", Status: "todo", DUE: "2026-08-01" }), note({ status: "done", due: "2026-08-02" })];
  const cols = dbColumns(
    notes,
    { status: { options: [] }, Due: { options: [], kind: "date" } }
  );
  // The first spelling already on disk wins each folded key. Status still
  // leads via COLUMN_ORDER even though its observed spelling is upper-case.
  assert.deepEqual(cols, ["Status", "DUE"]);
  assert.equal(foldedPropStr(notes[1].props, "Status"), "done");
  assert.equal(foldedPropKey(notes[1].props, "Status"), "status");
  assert.equal(foldedPropKey(notes[1].props, "new-key"), "new-key");
  assert.equal(foldedPropStr({ Status: "first", status: "exact" }, "status"), "exact");
});

test("persisted column identities resolve to canonical casing without broadening", () => {
  const union = ["Status", "DUE"];
  assert.equal(canonicalColumn(union, "status"), "Status");
  assert.deepEqual(effectiveColumns({ columns: ["due", "status"] }, union), ["DUE", "Status"]);
  assert.equal(boardGroupBy(union, { status: { options: [] } }, "status"), "Status");
});

test("view preference writes collapse case-only hidden, wrap, and width identities", () => {
  const pref = canonicalViewPref(
    {
      view: "table",
      group_by: "status",
      table_group_by: "due",
      hidden: ["status", "Status"],
      hidden_per_layout: { table: ["STATUS"], list: ["due"] },
      wrap: ["status", "Status"],
      widths: { status: 111, Status: 222, due: 90 },
      aggregations: { status: "count", STATUS: "max" },
      sorts: [{ key: "STATUS", dir: 1 }],
    },
    ["Status", "DUE"]
  );
  assert.equal(pref.group_by, "Status");
  assert.equal(pref.table_group_by, "DUE");
  assert.deepEqual(pref.hidden, ["Status"]);
  assert.deepEqual(pref.hidden_per_layout, { table: ["Status"], list: ["DUE"] });
  assert.deepEqual(pref.wrap, ["Status"]);
  assert.deepEqual(pref.widths, { Status: 222, DUE: 90 });
  assert.deepEqual(pref.aggregations, { Status: "count" });
  assert.deepEqual(pref.sorts, [{ key: "Status", dir: 1 }]);

  // DatabasePane mutates this canonical base, so each action targets the key
  // the read side rendered instead of leaving the hand-edited alias behind.
  assert.deepEqual(pref.hidden?.filter((key) => key !== "Status"), []); // unhide
  assert.deepEqual(pref.wrap?.filter((key) => key !== "Status"), []); // unwrap
  const widths: Record<string, number> = { ...pref.widths };
  delete widths.Status;
  assert.deepEqual(widths, { DUE: 90 }); // reset width
});

test("canonical column records preserve prototype-shaped property names", () => {
  const record = JSON.parse('{"TOSTRING":120,"__PROTO__":80}') as Record<string, number>;
  const normalized = canonicalColumnRecord(["toString", "__proto__"], record);

  assert.deepEqual(Object.keys(normalized), ["toString", "__proto__"]);
  assert.equal(normalized.toString, 120);
  assert.equal(normalized.__proto__, 80);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test("the reserved icon key is not a column (SUB-27 flattened shape)", () => {
  const cols = dbColumns(
    [],
    { icon: { glyph: "music" } as never, status: { options: [{ value: "live" }] } }
  );
  assert.deepEqual(cols, ["status"]);
});

test("boardGroupBy: multi-kind props are never candidates (SUB-79)", () => {
  const schema = {
    status: { options: [{ value: "live" }] },
    format: { options: [{ value: "Vinyl" }], kind: "multi" as const },
  };
  const cols = ["status", "format", "artist"];
  assert.equal(boardGroupBy(cols, schema, "artist"), "artist", "a groupable pref wins");
  assert.equal(
    boardGroupBy(cols, schema, "format"),
    "status",
    "a pref pointing at a multi prop falls back, no crash"
  );
  assert.equal(boardGroupBy(cols, schema), "status", "status leads by default");
  assert.equal(boardGroupBy(["format"], schema), undefined, "all-multi schema groups by nothing");
});

test("hiddenForLayout: a layout's own set wins; the flat hidden seeds both (SUB-642)", () => {
  // a pre-SUB-642 pref carries only the flat list — both layouts read it
  // (the read-side migration); board/gallery read the table set
  const old = { hidden: ["cat#"] };
  assert.deepEqual(hiddenForLayout(old, "table"), ["cat#"]);
  assert.deepEqual(hiddenForLayout(old, "list"), ["cat#"]);
  assert.deepEqual(hiddenForLayout(old, "board"), ["cat#"]);
  assert.deepEqual(hiddenForLayout(old, "gallery"), ["cat#"]);

  // per-layout sets are independent — each layout reads its own and the flat
  // seed is ignored where a set exists
  const split = { hidden: ["cat#"], hidden_per_layout: { table: ["artist"], list: ["status"] } };
  assert.deepEqual(hiddenForLayout(split, "table"), ["artist"]);
  assert.deepEqual(hiddenForLayout(split, "list"), ["status"]);

  // a layout with no set of its own still falls back to the flat seed
  const partial = { hidden: ["cat#"], hidden_per_layout: { table: ["artist"] } };
  assert.deepEqual(hiddenForLayout(partial, "table"), ["artist"]);
  assert.deepEqual(hiddenForLayout(partial, "list"), ["cat#"], "list seeds from the flat list");

  // nothing anywhere → everything shows
  assert.deepEqual(hiddenForLayout(undefined, "table"), []);
  assert.deepEqual(hiddenForLayout({}, "list"), []);
  assert.deepEqual(hiddenForLayout({ hidden_per_layout: {} }, "table"), []);
});

test("effectiveColumns: no view or no columns field yields the dbColumns union (SUB-212)", () => {
  const union = ["status", "artist", "released"];
  assert.equal(effectiveColumns(undefined, union), union, "no view at all");
  assert.equal(effectiveColumns({}, union), union, "columns absent");
  assert.equal(effectiveColumns({ columns: [] }, union), union, "columns empty");
});

test("notion_id is importer bookkeeping, never a column (SUB-328)", () => {
  const cols = dbColumns(
    [note({ type: "contact", email: "a@b.c", notion_id: "1a06c096-c147-81ce" })],
    {}
  );
  assert.ok(!cols.includes("notion_id"), "notion_id excluded from the union");
  assert.ok(cols.includes("email"), "real props still present");
});

test("effectiveColumns: the view's order wins, unknown keys drop out quietly", () => {
  const union = ["status", "cat#", "artist", "released"];
  assert.deepEqual(
    effectiveColumns({ columns: ["artist", "status"] }, union),
    ["artist", "status"],
    "subset in the view's own order, not the union's"
  );
  assert.deepEqual(
    effectiveColumns({ columns: ["mood", "artist", "staus"] }, union),
    ["artist"],
    "renamed/typo'd keys are ignored"
  );
  assert.deepEqual(
    effectiveColumns({ columns: ["mood", "staus"] }, union),
    union,
    "nothing valid left → the default union, never a column-less table"
  );
});

test("orderedColumns: a drag order leads, later props keep their default slot (SUB-949)", () => {
  const union = ["status", "cat#", "artist", "released"];
  assert.equal(orderedColumns(union, undefined), union, "no order → untouched");
  assert.equal(orderedColumns(union, []), union, "empty order → untouched");
  assert.deepEqual(
    orderedColumns(union, ["artist", "status", "cat#", "released"]),
    ["artist", "status", "cat#", "released"],
    "a full order is applied verbatim"
  );
  assert.deepEqual(
    orderedColumns(union, ["released", "artist"]),
    ["released", "artist", "status", "cat#"],
    "a prop added after the drag appends in its default position, never vanishes"
  );
  assert.deepEqual(
    orderedColumns(union, ["Artist", "STATUS"]),
    ["artist", "status", "cat#", "released"],
    "persisted casing resolves to the column's canonical spelling"
  );
  assert.deepEqual(
    orderedColumns(union, ["artist", "artist", "status"]),
    ["artist", "status", "cat#", "released"],
    "a duplicated key is taken once"
  );
  assert.deepEqual(
    orderedColumns(union, ["mood", "artist", "staus"]),
    ["artist", "status", "cat#", "released"],
    "renamed/typo'd keys drop out quietly"
  );
  assert.equal(
    orderedColumns(union, ["mood", "staus"]),
    union,
    "a fully stale order leaves the default untouched"
  );
});
