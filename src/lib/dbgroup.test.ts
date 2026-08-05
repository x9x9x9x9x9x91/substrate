import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketByProp,
  distinctNotes,
  extraValues,
  orderedNotes,
  tableGroupBy,
  tableGroups,
} from "./dbgroup.ts";
import type { NoteMeta, PropSchema, SelectOption } from "./types.ts";

function note(title: string, props: Record<string, unknown>): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
  };
}

const OPTS: SelectOption[] = [
  { value: "mix engineer", color: "blue" },
  { value: "artwork", color: "violet" },
  { value: "booking", color: "teal" },
];

test("bucketByProp: value-less notes collect in none, take drains case-insensitively", () => {
  const a = note("a", { role: "Live" });
  const b = note("b", { role: "live" });
  const c = note("c", {});
  const d = note("d", { role: "" });
  const { none, take } = bucketByProp([a, b, c, d], "role");
  assert.deepEqual(none, [c, d], "missing and empty-string values both count as none");
  assert.deepEqual(take("LIVE"), [a, b], "one take drains every casing variant");
  assert.deepEqual(take("live"), [], "drained buckets stay drained");
});

test("bucketByProp reads one canonical column across note key casing (SUB-728)", () => {
  const upper = note("upper", { Status: "todo" });
  const lower = note("lower", { status: "todo" });
  const { none, take } = bucketByProp([upper, lower], "Status");
  assert.deepEqual(none, []);
  assert.deepEqual(take("todo"), [upper, lower]);
});

test("tableGroupBy resolves a persisted key to canonical casing (SUB-728)", () => {
  assert.equal(tableGroupBy(["Status"], { status: { options: [] } }, "status"), "Status");
  assert.equal(tableGroupBy(["FORMAT"], { format: { options: [], kind: "multi" } }, "format"), undefined);
});

test("tableGroups: schema option order wins over alphabetical, empty options drop", () => {
  const rows = [
    note("b1", { role: "booking" }),
    note("m1", { role: "mix engineer" }),
    note("a1", { role: "artwork" }),
    note("m2", { role: "mix engineer" }),
  ];
  const groups = tableGroups(rows, "role", OPTS);
  assert.deepEqual(
    groups.map((g) => [g.value, g.notes.length]),
    [
      ["mix engineer", 2],
      ["artwork", 1],
      ["booking", 1],
    ],
    "option order as defined in the schema, not alphabetical"
  );
});

test("tableGroups: an option with no visible rows forms no section", () => {
  const groups = tableGroups([note("a", { role: "artwork" })], "role", OPTS);
  assert.deepEqual(groups.map((g) => g.value), ["artwork"]);
});

test("tableGroups: unschema'd values follow the options, alphabetical, casing-deduped", () => {
  const rows = [
    note("m", { role: "mix engineer" }),
    note("x", { role: "DJ" }),
    note("y", { role: "dj" }),
    note("z", { role: "A&R" }),
  ];
  const groups = tableGroups(rows, "role", OPTS);
  assert.deepEqual(groups.map((g) => g.value), ["mix engineer", "A&R", "DJ"]);
  assert.deepEqual(groups[2].notes, [rows[1], rows[2]], "casing variants share one section");
});

test("tableGroups: a casing variant of an option joins the option's section", () => {
  const groups = tableGroups([note("m", { role: "Mix Engineer" })], "role", OPTS);
  assert.deepEqual(groups.map((g) => g.value), ["mix engineer"]);
});

test("tableGroups: the no-value section trails, and drops when everyone has a value", () => {
  const withNone = tableGroups(
    [note("m", { role: "booking" }), note("n", { city: "Berlin" })],
    "role",
    OPTS
  );
  assert.deepEqual(
    withNone.map((g) => g.value),
    ["booking", null],
    "the 'No …' section is last"
  );
  const withoutNone = tableGroups([note("m", { role: "booking" })], "role", OPTS);
  assert.equal(withoutNone.some((g) => g.value === null), false);
});

test("tableGroups: rows keep incoming order inside a section (sort applies per section)", () => {
  const rows = [
    note("z", { role: "booking" }),
    note("a", { role: "booking" }),
  ];
  assert.deepEqual(tableGroups(rows, "role", OPTS)[0].notes, rows, "no reordering here");
});

test("tableGroupBy: the pref wins only while it names a groupable column", () => {
  const schema = {
    role: { options: OPTS },
    tags: { options: [{ value: "x" }], kind: "multi" as const },
  };
  const cols = ["role", "tags", "city"];
  assert.equal(tableGroupBy(cols, schema, "role"), "role");
  assert.equal(tableGroupBy(cols, schema, "tags"), undefined, "multi-kind never groups (SUB-79)");
  assert.equal(tableGroupBy(cols, schema, "gone"), undefined, "stale pref → ungrouped");
  assert.equal(tableGroupBy(cols, schema, undefined), undefined, "no pref, no fallback");
  assert.equal(tableGroupBy(cols, schema, "city"), "city", "unschema'd columns may group");
});

test("extraValues: values from the full note set, schema options excluded", () => {
  const notes = [note("a", { s: "beta" }), note("b", { s: "alpha" }), note("c", { s: "live" })];
  assert.deepEqual(extraValues(notes, "s", [{ value: "live" }]), ["alpha", "beta"]);
});

test("bucketByProp: a list-valued prop files the note under EACH item (SUB-221)", () => {
  const ab = note("ab", { tags: ["a", "b"] });
  const dup = note("dup", { tags: ["a", "A"] });
  const { none, take } = bucketByProp([ab, dup], "tags");
  assert.deepEqual(none, []);
  assert.deepEqual(take("A"), [ab, dup], "casing variants drain together, one entry per note");
  assert.deepEqual(take("b"), [ab], "the note also shows under its other item");
});

test("bucketByProp: empty lists count as no value, non-string lists keep the joined display", () => {
  const e = note("e", { tags: [] });
  const nums = note("nums", { tags: [1, 2] });
  const { none, take } = bucketByProp([e, nums], "tags");
  assert.deepEqual(none, [e]);
  assert.deepEqual(take("[1,2]"), [nums], "non-string lists stay one JSON bucket");
});

test("tableGroups: unschema'd list values form one section per item", () => {
  const rows = [note("n1", { tags: ["b", "a"] }), note("n2", { tags: ["A"] })];
  const groups = tableGroups(rows, "tags", []);
  assert.deepEqual(groups.map((g) => g.value), ["a", "b"]);
  assert.deepEqual(groups[0].notes, [rows[0], rows[1]], "casing variants of an item share a section");
  assert.deepEqual(groups[1].notes, [rows[0]], "the list note appears in both sections");
});

test("tableGroups: a list item matching a schema option joins the option's section", () => {
  const groups = tableGroups([note("m", { role: ["booking", "artwork"] })], "role", OPTS);
  assert.deepEqual(groups.map((g) => g.value), ["artwork", "booking"]);
  assert.deepEqual(groups[0].notes, groups[1].notes, "one note, both option sections");
});

test("extraValues: list items collect individually, casing-deduped", () => {
  const notes = [note("a", { s: ["beta", "alpha"] }), note("b", { s: ["ALPHA"] })];
  assert.deepEqual(extraValues(notes, "s", []), ["alpha", "beta"]);
});

test("distinctNotes: a note in several sections is counted once, in view order", () => {
  const a = note("a", { role: ["artwork", "booking"] });
  const b = note("b", { role: "booking" });
  const flat = tableGroups([a, b], "role", OPTS).flatMap((g) => g.notes);
  assert.deepEqual(flat.map((n) => n.title), ["a", "a", "b"], "a sits in both sections");
  assert.deepEqual(distinctNotes(flat).map((n) => n.title), ["a", "b"]);
});

test("distinctNotes: an ungrouped list passes through unchanged", () => {
  const ns = [note("a", {}), note("b", {}), note("c", {})];
  assert.deepEqual(distinctNotes(ns), ns);
});

/* SUB-639: a number-kind column groups by numeric VALUE, so the same amount
   spelled differently is one section, not two. */
const NUM_SCHEMA: Record<string, PropSchema> = { price: { options: [], kind: "number" } };

test("bucketByProp: a number column buckets by value, not spelling (SUB-639)", () => {
  const a = note("a", { price: "1200" });
  const b = note("b", { price: "1200.00" });
  const c = note("c", { price: "120" });
  const { none, take } = bucketByProp([a, b, c], "price", NUM_SCHEMA);
  assert.deepEqual(none, []);
  assert.deepEqual(take("1200.0"), [a, b], "same value, any spelling, one bucket");
  assert.deepEqual(take("120"), [c], "120 is its own bucket, not a prefix hit of 1200");
});

test("bucketByProp: without a schema a number column still buckets as text", () => {
  const a = note("a", { price: "1200" });
  const b = note("b", { price: "1200.00" });
  const { take } = bucketByProp([a, b], "price");
  assert.deepEqual(take("1200"), [a], "text semantics unchanged for schema-less callers");
});

test("bucketByProp: non-numeric cells in a number column keep their own bucket", () => {
  const a = note("a", { price: "tbd" });
  const b = note("b", { price: "TBD" });
  const c = note("c", { price: "0" });
  const { take } = bucketByProp([a, b, c], "price", NUM_SCHEMA);
  assert.deepEqual(take("tbd"), [a, b], "junk folds by casing, as text always did");
  assert.deepEqual(take("0"), [c]);
});

test("tableGroups: a number column yields one section per value (SUB-639)", () => {
  const rows = [
    note("a", { price: "1200" }),
    note("b", { price: "120.50" }),
    note("c", { price: "1200.00" }),
  ];
  const groups = tableGroups(rows, "price", [], NUM_SCHEMA);
  assert.equal(groups.length, 2, "1200 and 1200.00 share a section; 120.50 is its own");
  assert.deepEqual(groups.map((g) => g.value), ["120.50", "1200"], "sections run low to high");
  assert.deepEqual(
    groups.map((g) => g.notes.map((n) => n.title)),
    [["b"], ["a", "c"]]
  );
});

test("extraValues: a number column dedupes by value, first spelling wins (SUB-639)", () => {
  const notes = [note("a", { price: "1200" }), note("b", { price: "1200.00" })];
  assert.deepEqual(extraValues(notes, "price", [], NUM_SCHEMA), ["1200"]);
  assert.deepEqual(
    extraValues(notes, "price", []),
    ["1200", "1200.00"],
    "text semantics unchanged without a schema"
  );
});

test("orderedNotes: listed notes lead in order, the rest keep resting order (SUB-948)", () => {
  const a = note("a", {});
  const b = note("b", {});
  const c = note("c", {});
  assert.deepEqual(orderedNotes([a, b, c], undefined), [a, b, c], "no order = untouched");
  assert.deepEqual(orderedNotes([a, b, c], []), [a, b, c], "an empty order = untouched");
  assert.deepEqual(
    orderedNotes([a, b, c], ["c.md", "a.md"]).map((n) => n.title),
    ["c", "a", "b"],
    "unlisted notes append behind the ordered ones"
  );
});

test("orderedNotes: unknown paths cost nothing (SUB-948)", () => {
  const a = note("a", {});
  const b = note("b", {});
  assert.deepEqual(
    orderedNotes([a, b], ["gone.md", "b.md", "other-column.md", "b.md"]).map((n) => n.title),
    ["b", "a"],
    "missing paths, other columns' paths and duplicates are all skipped"
  );
  assert.deepEqual(
    orderedNotes([a, b], ["gone.md"]),
    [a, b],
    "an order matching nothing here leaves the column alone"
  );
});
