import { test } from "node:test";
import assert from "node:assert/strict";
import { cellModel, cellOpensEditor } from "./cellmodel.ts";
import type { PropSchema } from "./types.ts";

const schema: Record<string, PropSchema> = {
  // a select column is just options with no kind — the default (SUB-79)
  status: { options: [{ value: "live" }] },
  tags: { options: [], kind: "multi" },
  done: { options: [], kind: "checkbox" },
  artist: { options: [], kind: "relation", type: "person" },
  plays: { options: [], kind: "rollup" },
};

test("the note's own spelling of the key is what a write targets (SUB-796)", () => {
  const m = cellModel({ Status: "live" }, "status", schema);
  assert.equal(m.actualKey, "Status");
  assert.equal(m.val, "live");
  assert.equal(m.kind, undefined);
});

test("a missing prop still resolves a key and kind to write into", () => {
  const m = cellModel({}, "status", schema);
  assert.equal(m.actualKey, "status");
  assert.equal(m.val, "");
  assert.deepEqual(m.schema, schema.status);
});

test("multi and relation come back as lists, other kinds do not", () => {
  assert.deepEqual(cellModel({ tags: ["a", "b"] }, "tags", schema).list, ["a", "b"]);
  assert.deepEqual(cellModel({ artist: "Ada" }, "artist", schema).list, ["Ada"]);
  assert.deepEqual(cellModel({ status: "live" }, "status", schema).list, []);
});

test("checkbox is on only for the YAML bool true (SUB-173)", () => {
  assert.equal(cellModel({ done: true }, "done", schema).checked, true);
  assert.equal(cellModel({ done: false }, "done", schema).checked, false);
  assert.equal(cellModel({ done: "true" }, "done", schema).checked, false);
  assert.equal(cellModel({}, "done", schema).checked, false);
});

test("created/updated read as dates without a schema entry (SUB-167)", () => {
  assert.equal(cellModel({ created: "2026-08-02" }, "created", schema).kind, "date");
  // an explicit schema entry still wins over the built-in guess
  assert.equal(cellModel({ created: "x" }, "created", { created: { options: [], kind: "text" } }).kind, "text");
});

test("an unknown column has no kind — it edits as plain text", () => {
  const m = cellModel({ mood: "blue" }, "mood", schema);
  assert.equal(m.kind, undefined);
  assert.equal(m.val, "blue");
});

test("rollups and checkboxes never open an editor; everything else does", () => {
  assert.equal(cellOpensEditor("rollup"), false);
  assert.equal(cellOpensEditor("checkbox"), false);
  for (const kind of ["multi", "date", "relation", "text", "number", "url"] as const) {
    assert.equal(cellOpensEditor(kind), true, kind);
  }
  assert.equal(cellOpensEditor(undefined), true);
});
