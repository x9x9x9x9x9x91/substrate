import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, PropSchema } from "./types.ts";
import { propStr } from "./types.ts";
import { aggregate } from "./aggregate.ts";
import { rollupColumns, rollupProps, withRollups } from "./rollup.ts";

/** A NoteMeta fixture: title defaults to the path's stem. */
function note(path: string, props: Record<string, unknown>, title?: string): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop()!;
  return {
    path,
    stem,
    title: title ?? stem,
    folder: path.split("/").slice(0, -1).join("/"),
    props,
    updated_ms: 0,
    excerpt: "",
  };
}

/** The Releases/Royalty Ledger pair the issue names: `entries` is the
    relation a rollup follows, `amount` the target prop it reads. */
const LEDGER_SCHEMA: Record<string, PropSchema> = {
  amount: { options: [], kind: "number" },
};
const RELEASE_SCHEMA: Record<string, PropSchema> = {
  entries: { options: [], kind: "relation", type: "ledger" },
  earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "sum" },
};

const L1 = note("Ledger/L1.md", { type: "ledger", amount: "100" });
const L2 = note("Ledger/L2.md", { type: "ledger", amount: "250.5" });
const L3 = note("Ledger/L3.md", { type: "ledger", amount: "70" });
const JUNK = note("Ledger/J.md", { type: "ledger", amount: "ask" });
const ALL = [L1, L2, L3, JUNK];

test("rollupProps extracts only complete rollup entries", () => {
  assert.deepEqual(rollupProps(RELEASE_SCHEMA), {
    earned: { relation: "entries", prop: "amount", agg: "sum" },
  });
  // half-written hand edits read as "no usable rollup", never as an error
  assert.deepEqual(
    rollupProps({
      a: { options: [], kind: "rollup", relation: "entries" } as PropSchema,
      b: { options: [], kind: "rollup", relation: "entries", prop: "amount" } as PropSchema,
      c: { options: [], kind: "text" },
    }),
    {}
  );
  // the reserved icon/home keys ride the same record and pass the check
  assert.deepEqual(
    rollupProps({ icon: { glyph: "music" }, home: "Releases" } as never),
    {}
  );
});

test("no rollup props → null, the zero-cost bail", () => {
  assert.equal(rollupColumns(ALL, LEDGER_SCHEMA, ALL), null);
});

test("sum over linked rows, scalar and list relation values", () => {
  const rows = [
    note("Releases/R1.md", { type: "release", entries: "L1" }),
    note("Releases/R2.md", { type: "release", entries: ["L1", "L2"] }),
  ];
  const rolled = rollupColumns(rows, RELEASE_SCHEMA, ALL)!;
  assert.equal(rolled.get("Releases/R1.md")?.earned, "100");
  assert.equal(rolled.get("Releases/R2.md")?.earned, "350.5");
});

test("empty relation: sum reads as no value, count as 0 (the footer's convention)", () => {
  const schema: Record<string, PropSchema> = {
    ...RELEASE_SCHEMA,
    earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "sum" },
    pays: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "count" },
  };
  const rows = [note("Releases/R1.md", { type: "release" })];
  const rolled = rollupColumns(rows, schema, ALL)!;
  // sum over zero links is absent — the row may fall out of the map entirely
  assert.equal(rolled.get("Releases/R1.md")?.earned, undefined);
  assert.equal(rolled.get("Releases/R1.md")?.pays, "0");
});

test("non-numeric target values are skipped by the shared coercion", () => {
  const rows = [note("Releases/R1.md", { type: "release", entries: ["L1", "J"] })];
  const rolled = rollupColumns(rows, RELEASE_SCHEMA, ALL)!;
  assert.equal(rolled.get("Releases/R1.md")?.earned, "100", '"ask" never reaches the sum');
  // ALL targets junk → no value at all
  const rows2 = [note("Releases/R2.md", { type: "release", entries: ["J"] })];
  const rolled2 = rollupColumns(rows2, RELEASE_SCHEMA, ALL)!;
  assert.equal(rolled2.get("Releases/R2.md"), undefined);
});

test("avg/min/max variants over the linked rows", () => {
  const mk = (agg: "avg" | "min" | "max"): Record<string, PropSchema> => ({
    ...RELEASE_SCHEMA,
    earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg },
  });
  const rows = [note("Releases/R1.md", { type: "release", entries: ["L1", "L2", "L3"] })];
  assert.equal(rollupColumns(rows, mk("avg"), ALL)!.get("Releases/R1.md")?.earned, "140.16666666666666");
  assert.equal(rollupColumns(rows, mk("min"), ALL)!.get("Releases/R1.md")?.earned, "70");
  assert.equal(rollupColumns(rows, mk("max"), ALL)!.get("Releases/R1.md")?.earned, "250.5");
});

test("dangling titles link nothing and are skipped", () => {
  const rows = [note("Releases/R1.md", { type: "release", entries: ["L1", "Gone"] })];
  const rolled = rollupColumns(rows, RELEASE_SCHEMA, ALL)!;
  assert.equal(rolled.get("Releases/R1.md")?.earned, "100");
});

test("matching is case-insensitive on type, title and stem", () => {
  const rows = [
    note("Releases/R1.md", { type: "release", entries: ["l1", "L2".toUpperCase()] }),
  ];
  const rolled = rollupColumns(rows, RELEASE_SCHEMA, ALL)!;
  assert.equal(rolled.get("Releases/R1.md")?.earned, "350.5");
  // a schema with shouty casing still wires up
  const schema: Record<string, PropSchema> = {
    Entries: { options: [], kind: "relation", type: "LEDGER" },
    earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "sum" },
  };
  const rows2 = [note("Releases/R2.md", { type: "release", Entries: "L3" })];
  assert.equal(rollupColumns(rows2, schema, ALL)!.get("Releases/R2.md")?.earned, "70");
});

test("a relation that isn't relation-kind links no rows", () => {
  const schema: Record<string, PropSchema> = {
    entries: { options: [], kind: "text" },
    earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "sum" },
  };
  const rows = [note("Releases/R1.md", { type: "release", entries: "L1" })];
  assert.equal(rollupColumns(rows, schema, ALL)!.size, 0);
});

test("a rollup reads stored values only — another rollup is invisible to it", () => {
  const schema: Record<string, PropSchema> = {
    entries: { options: [], kind: "relation", type: "ledger" },
    earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "sum" },
    doubled: { options: [], kind: "rollup", relation: "entries", prop: "earned", agg: "sum" },
  };
  const rows = [note("Releases/R1.md", { type: "release", entries: ["L1"] })];
  const rolled = rollupColumns(rows, schema, ALL)!;
  assert.equal(rolled.get("Releases/R1.md")?.earned, "100");
  assert.equal(rolled.get("Releases/R1.md")?.doubled, undefined);
});

test("withRollups folds derived values into the display model", () => {
  const rows = [
    note("Releases/R1.md", { type: "release", entries: ["L1", "L2"] }),
    note("Releases/R2.md", { type: "release" }),
    note("Releases/R3.md", { type: "release", earned: "999" }), // hand-authored junk
  ];
  const rolled = rollupColumns(rows, RELEASE_SCHEMA, ALL)!;
  const disp = withRollups(rows, rolled, ["earned"]);
  assert.equal(disp[0].props.earned, "350.5");
  assert.equal("earned" in disp[1].props, false, "no value → key deleted, reads missing");
  assert.equal(disp[2].props.earned, undefined, "junk with no derivation drops too");
  assert.equal(disp[0].props.entries, rows[0].props.entries, "other props untouched");
  assert.equal(rows[0].props.earned, undefined, "the input is never mutated");
});

test("withRollups keeps identity for untouched notes", () => {
  const rows = [note("Releases/R1.md", { type: "release", entries: ["L1"] })];
  const disp = withRollups(rows, new Map(), ["earned"]);
  assert.equal(disp[0], rows[0], "nothing to inject → same object");
});

test("derived strings round-trip through the footer's coercion", () => {
  const rows = [
    note("Releases/R1.md", { type: "release", entries: ["L1", "L2"] }),
    note("Releases/R2.md", { type: "release", entries: ["L3"] }),
  ];
  const rolled = rollupColumns(rows, RELEASE_SCHEMA, ALL)!;
  const disp = withRollups(rows, rolled, ["earned"]);
  // the footer aggregates the rollup column itself through the same propStr path
  assert.equal(
    aggregate("sum", disp.map((n) => propStr(n.props, "earned") ?? "")),
    420.5
  );
});
