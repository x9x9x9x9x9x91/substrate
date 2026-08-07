import { test } from "node:test";
import assert from "node:assert/strict";
import { headerIndex, readNoteTable } from "./notetable.ts";

function noteWith(lines: string[]): string {
  return ["A note.", "", "```csv", ...lines, "```", ""].join("\n");
}

test("readNoteTable: null when the note has no csv fence", () => {
  assert.equal(readNoteTable("Just prose.\n"), null);
  assert.equal(readNoteTable("```formulas\nsum = 1\n```\n"), null);
});

test("readNoteTable: header row is split off; rows are data rows only", () => {
  const t = readNoteTable(noteWith(["date,kg", "2026-07-24,68.0", "2026-07-25,67.4"]));
  assert.ok(t);
  assert.deepEqual(t.headers, ["date", "kg"]);
  assert.deepEqual(t.rows, [
    ["2026-07-24", "68.0"],
    ["2026-07-25", "67.4"],
  ]);
  // a data row's index is its position in `rows` — the delete handle panes persist
  assert.equal(t.rows.length, 2);
});

test("readNoteTable: an empty fence is still a table, with no headers", () => {
  const t = readNoteTable(noteWith([]));
  assert.ok(t, "the fence is real even when it parses to nothing");
  assert.deepEqual(t.headers, []);
  assert.deepEqual(t.rows, []);
  // every column lookup misses, which is what turns into the caller's
  // "nothing to show" guard
  assert.equal(t.col("date"), -1);
  assert.deepEqual(t.allRows(), []);
});

test("col: name-based, case- and whitespace-insensitive", () => {
  const t = readNoteTable(noteWith(["  Date , KCAL ,food", "2026-07-24,700,rice"]));
  assert.ok(t);
  assert.equal(t.col("date"), 0);
  assert.equal(t.col("kcal"), 1);
  assert.equal(t.col("food"), 2);
  assert.equal(t.col("protein_g"), -1);
});

test("col: several names are spellings of ONE column, resolved in header order", () => {
  // a hand-edited sheet carrying both spellings: the sheet owner's column
  // wins, not the argument order
  const t = readNoteTable(noteWith(["name,g_per_unit,g", "Eggs,55,60"]));
  assert.ok(t);
  assert.equal(t.col("g", "g_per_unit"), 1);
  assert.equal(t.col("g_per_unit", "g"), 1);
});

test("text trims, raw doesn't; both read absent columns as empty", () => {
  const t = readNoteTable(noteWith(["a,b", '" 7 ",x']));
  assert.ok(t);
  const row = t.rows[0];
  assert.equal(t.text(row, 0), "7");
  assert.equal(t.raw(row, 0), " 7 ");
  // missing column, and a row shorter than the header
  assert.equal(t.text(row, -1), "");
  assert.equal(t.raw(row, -1), "");
  assert.equal(t.text(row, 9), "");
  assert.equal(t.raw(row, 9), "");
});

test("allRows: header + data, and reflects a spliced row (the delete path)", () => {
  const t = readNoteTable(noteWith(["date,kg", "2026-07-24,68", "2026-07-25,67"]));
  assert.ok(t);
  assert.deepEqual(t.allRows(), [
    ["date", "kg"],
    ["2026-07-24", "68"],
    ["2026-07-25", "67"],
  ]);
  t.rows.splice(0, 1);
  assert.deepEqual(t.allRows(), [
    ["date", "kg"],
    ["2026-07-25", "67"],
  ]);
});

test("fence is the csv fence the table came from", () => {
  const body = noteWith(["date,kg", "2026-07-24,68"]);
  const t = readNoteTable(body);
  assert.ok(t);
  assert.equal(t.fence.inner.trim().split("\n")[0], "date,kg");
  assert.equal(body.slice(t.fence.from, t.fence.to).includes("2026-07-24,68"), true);
});

test("headerIndex: standalone form, for writers growing their own header row", () => {
  const headers = ["date", " Food ", "kcal"];
  assert.equal(headerIndex(headers, "food"), 1);
  assert.equal(headerIndex(headers, "protein_g"), -1);
  assert.equal(headerIndex(headers, "g", "g_per_unit"), -1);
  assert.equal(headerIndex([], "date"), -1);
});
