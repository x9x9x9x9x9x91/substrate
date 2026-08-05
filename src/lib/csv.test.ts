import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsv } from "./csv.ts";
import { tableGroups } from "./dbgroup.ts";
import type { NoteMeta } from "./types.ts";

function note(title: string, props: Record<string, unknown>): NoteMeta {
  return { path: `${title}.md`, stem: title, title, folder: "", props, updated_ms: 0, excerpt: "", sealed: false };
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

// SUB-903: a cell whose first character is =, +, - or @ is a live formula in
// Excel/Numbers/LibreOffice, so exports carry the standard `'` text marker.
test("buildCsv prefixes cells that a spreadsheet would evaluate", () => {
  const rows = [
    note("Payload", { memo: "=cmd|'/c calc'!A1" }),
    note("Plus", { memo: "+1+1" }),
    note("Minus", { memo: "-5" }),
    note("At", { memo: "@SUM(A1)" }),
  ];
  assert.equal(
    buildCsv(["memo"], rows),
    "title,memo\nPayload,'=cmd|'/c calc'!A1\nPlus,'+1+1\nMinus,'-5\nAt,'@SUM(A1)\n"
  );
});

test("buildCsv quotes an escaped cell that also needs RFC-4180 quoting", () => {
  const rows = [note("Link", { memo: '=HYPERLINK("http://x","click")' })];
  assert.equal(
    buildCsv(["memo"], rows),
    'title,memo\nLink,"\'=HYPERLINK(""http://x"",""click"")"\n'
  );
});

test("buildCsv leaves a formula-looking string alone unless it LEADS the cell", () => {
  const rows = [note("Note", { memo: "total = SUM(A1:A9)" }), note("Dash", { memo: "a-b" })];
  assert.equal(buildCsv(["memo"], rows), "title,memo\nNote,total = SUM(A1:A9)\nDash,a-b\n");
});

test("buildCsv escapes a title and a column header the same way", () => {
  const rows = [note("=Injected", { "-rate": "ok" })];
  assert.equal(buildCsv(["-rate"], rows), "title,'-rate\n'=Injected,ok\n");
});

// Roundtrip note: the prefix is export-only. Re-importing an exported file
// through our own parser keeps `'=x` as the literal text `'=x` (no unescaping
// step exists, by design — see csv.ts); spreadsheets consume the marker when
// they open the file. Nothing in the vault gains an apostrophe: the in-note
// sheet writer (sheet.ts serializeCsv) and the importer are untouched.
test("buildCsv: the escape does not survive as a formula through re-parse", () => {
  const out = buildCsv(["memo"], [note("P", { memo: "=1+1" })]);
  const cell = out.split("\n")[1].split(",")[1];
  assert.equal(cell, "'=1+1");
  assert.ok(!cell.startsWith("="), "re-parsed cell is inert text, not a formula");
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
