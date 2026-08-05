import { test } from "node:test";
import assert from "node:assert/strict";
import { embedQueryFor, parseViewSpec } from "./embeds.ts";
import {
  isJoinedColumn,
  viewCellEditable,
  viewCellModel,
  viewCellWritable,
} from "./viewcell.ts";
import type { EmbedResult } from "./embeds.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

/* Cell meaning inside an inline ```view table — the read-only-ness a joined
   column (SUB-829) has to hold on EVERY surface: paint, editor-opening click,
   and the checkbox toggle that writes without opening anything. */

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

const SCHEMA: SchemaConfig = {
  release: {
    // the target carries a checkbox: the joined column inherits nothing from
    // it, which is exactly the point
    approved: { options: [], kind: "checkbox" },
    catalog: { options: [] },
  },
  master: {
    done: { options: [], kind: "checkbox" },
    stage: { options: [] },
    release: { options: [], kind: "relation", type: "release" },
  },
};

const NOTES: NoteMeta[] = [
  note("Slow Bloom EP", { type: "release", approved: true, catalog: "SMP-030" }),
  note("Master A", { type: "master", stage: "cut", done: true, release: "Slow Bloom EP" }),
];

function query(fence: string): Exclude<EmbedResult, { error: string }> {
  const r = embedQueryFor(parseViewSpec(fence), NOTES, SCHEMA, []);
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  return r as Exclude<EmbedResult, { error: string }>;
}

const propsOf = (r: Exclude<EmbedResult, { error: string }>, title: string) =>
  r.rows.find((row) => row.title === title)!.props;

test("a joined column is recognised as a lookup, a stored one is not", () => {
  const r = query("type: master\ncolumns: done, release.approved\n");
  assert.equal(isJoinedColumn(r, "release.approved"), true);
  assert.equal(isJoinedColumn(r, "done"), false);
  assert.equal(isJoinedColumn(r, "stage"), false);
});

test("a joined cell has no derived model — its value lives on another row", () => {
  const r = query("type: master\ncolumns: release.approved\n");
  const model = viewCellModel(r, propsOf(r, "Master A"), "release.approved");
  // nothing to write to, nothing to key off: an inert model by construction,
  // not by the accident of the base row happening not to hold that key
  assert.equal(model.actualKey, "");
  assert.equal(model.val, "");
  assert.equal(model.kind, undefined);
  assert.equal(model.checked, false);
  assert.deepEqual(model.list, []);
});

test("a joined cell never opens an editor and never takes a write", () => {
  const r = query("type: master\ncolumns: done, release.approved\n");
  const joined = viewCellModel(r, propsOf(r, "Master A"), "release.approved");
  assert.equal(viewCellEditable(r, "release.approved", joined), false);
  // the checkbox toggle writes WITHOUT opening an editor, so this is the
  // guard the mousedown handler needs — the editor guard doesn't cover it
  assert.equal(viewCellWritable(r, "release.approved"), false);
});

test("a checkbox-kind JOINED cell is unwritable even though a stored one toggles", () => {
  // the regression this pins: `done` (stored, checkbox) must still toggle, and
  // a lookup at a target's checkbox must not — the two differ only in being a
  // join, so a guard keyed on kind alone would let the joined one through
  const r = query("type: master\ncolumns: done, release.approved\n");
  const props = propsOf(r, "Master A");
  const own = viewCellModel(r, props, "done");
  assert.equal(own.kind, "checkbox");
  assert.equal(own.checked, true);
  assert.equal(viewCellWritable(r, "done"), true);
  assert.equal(viewCellWritable(r, "release.approved"), false);
});

test("a stored checkbox still refuses to OPEN an editor — it toggles in place", () => {
  const r = query("type: master\ncolumns: done\n");
  const own = viewCellModel(r, propsOf(r, "Master A"), "done");
  assert.equal(viewCellEditable(r, "done", own), false); // no picker
  assert.equal(viewCellWritable(r, "done"), true); // but it writes
});

test("a stored text cell opens an editor and writes", () => {
  const r = query("type: master\ncolumns: stage\n");
  const model = viewCellModel(r, propsOf(r, "Master A"), "stage");
  assert.equal(viewCellEditable(r, "stage", model), true);
  assert.equal(viewCellWritable(r, "stage"), true);
  assert.equal(model.actualKey, "stage");
});

test("an errored fence has no editable or writable cells at all", () => {
  const err = embedQueryFor(parseViewSpec("type: nosuchtype\n"), NOTES, SCHEMA, []);
  assert.ok("error" in err);
  assert.equal(viewCellWritable(err, "anything"), false);
  assert.equal(
    viewCellEditable(err, "anything", {
      actualKey: "anything",
      val: "",
      schema: undefined,
      kind: undefined,
      list: [],
      checked: false,
    }),
    false
  );
  assert.equal(isJoinedColumn(err, "anything"), false);
});
