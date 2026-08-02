import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsv } from "./csv.ts";
import { tableGroups } from "./dbgroup.ts";
import type { NoteMeta } from "./types.ts";

function note(title: string, props: Record<string, unknown>): NoteMeta {
  return { path: `${title}.md`, stem: title, title, folder: "", props, updated_ms: 0, excerpt: "" };
}

test("buildCsv emits header, row order, and blanks for missing props", () => {
  const rows = [
    note("Slow Bloom EP", { status: "in review", "cat#": "SMP-030" }),
    note("Vessel Songs", { status: "mastering" }),
  ];
  assert.equal(
    buildCsv(["status", "cat#"], rows),
    "title,status,cat#\nSlow Bloom EP,in review,SMP-030\nVessel Songs,mastering,\n"
  );
});

test("buildCsv reads a canonical column across note key casing (SUB-728)", () => {
  const rows = [note("Upper", { Status: "todo" }), note("Lower", { status: "done" })];
  assert.equal(buildCsv(["Status"], rows), "title,Status\nUpper,todo\nLower,done\n");
});

test("buildCsv quotes commas, doubles quotes, keeps newlines quoted", () => {
  const rows = [note('He said "go, now"', { memo: "line one\nline two" })];
  assert.equal(
    buildCsv(["memo"], rows),
    'title,memo\n"He said ""go, now""","line one\nline two"\n'
  );
});

test("buildCsv stringifies non-string props like the table does", () => {
  const rows = [note("Config", { cards: [{ label: "x" }] })];
  assert.equal(buildCsv(["cards"], rows), 'title,cards\nConfig,"[{""label"":""x""}]"\n');
});

// SUB-563: grouping is view-only, so exporting a grouped table
// yields one row per note — the same file the ungrouped view exports.
test("buildCsv: a note in two group sections exports once, in view order", () => {
  const both = note("Split Signals", { artist: ["Vela Roan", "Immo Krass"] });
  const one = note("Deep Field", { artist: "Immo Krass" });
  const opts = [{ value: "Vela Roan" }, { value: "Immo Krass" }];
  const grouped = tableGroups([both, one], "artist", opts).flatMap((g) => g.notes);
  assert.deepEqual(
    grouped.map((n) => n.title),
    ["Split Signals", "Split Signals", "Deep Field"],
    "the grouped view really shows the two-artist release twice"
  );
  assert.equal(
    buildCsv(["artist"], grouped),
    'title,artist\nSplit Signals,"Vela Roan, Immo Krass"\nDeep Field,Immo Krass\n'
  );
});

test("buildCsv: grouped and ungrouped exports of one view are identical", () => {
  const notes = [
    note("Split Signals", { artist: ["Vela Roan", "Immo Krass"] }),
    note("Deep Field", { artist: "Immo Krass" }),
    note("Unsigned", {}),
  ];
  const opts = [{ value: "Vela Roan" }, { value: "Immo Krass" }];
  const grouped = tableGroups(notes, "artist", opts).flatMap((g) => g.notes);
  assert.equal(buildCsv(["artist"], grouped), buildCsv(["artist"], notes));
});
