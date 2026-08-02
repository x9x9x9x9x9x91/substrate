import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csvColumns,
  csvEntries,
  csvSafeColumns,
  dbNameFromFile,
  type CsvColumn,
} from "./csvimport.ts";

const ROWS = [
  ["title", "status", "cat#"],
  ["Slow Bloom EP", "in review", "SMP-030"],
  ["Vessel Songs", "mastering", "SMP-031"],
];

const includeAll = (cols: CsvColumn[]) => cols;

test("csvColumns names the trimmed header row when headers are on", () => {
  const cols = csvColumns([[" name ", " status "], ["a", "b"]], true);
  assert.deepEqual(
    cols.map((c) => c.name),
    ["name", "status"],
  );
  assert.ok(cols.every((c) => c.include));
});

test("csvColumns falls back to positional names: headers off, or blank header cells", () => {
  assert.deepEqual(
    csvColumns(ROWS, false).map((c) => c.name),
    ["Column 1", "Column 2", "Column 3"],
  );
  assert.deepEqual(
    csvColumns([["title", "", "cat#"], ["a", "b", "c"]], true).map((c) => c.name),
    ["title", "Column 2", "cat#"],
  );
});

test("csvColumns covers the widest row so ragged cells keep a column", () => {
  const cols = csvColumns([["a", "b"], ["1", "2", "3"]], true);
  assert.deepEqual(
    cols.map((c) => c.name),
    ["a", "b", "Column 3"],
  );
});

test("csvEntries: first included column is the title, the rest are props in order", () => {
  const entries = csvEntries(ROWS, true, includeAll(csvColumns(ROWS, true)));
  assert.deepEqual(entries, [
    { title: "Slow Bloom EP", props: [["status", "in review"], ["cat#", "SMP-030"]] },
    { title: "Vessel Songs", props: [["status", "mastering"], ["cat#", "SMP-031"]] },
  ]);
});

test("csvEntries with headers off treats every row as data", () => {
  const entries = csvEntries(ROWS, false, includeAll(csvColumns(ROWS, false)));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    title: "title",
    props: [["Column 2", "status"], ["Column 3", "cat#"]],
  });
});

test("csvEntries: excluding the first column promotes the next one to title", () => {
  const cols = csvColumns(ROWS, true).map((c, i) => ({ ...c, include: i !== 0 }));
  const entries = csvEntries(ROWS, true, cols);
  assert.deepEqual(entries[0], { title: "in review", props: [["cat#", "SMP-030"]] });
});

test("csvEntries skips rows whose included cells are all blank", () => {
  const rows = [...ROWS, ["", " ", ""], ["Ghost", "", ""]];
  const entries = csvEntries(rows, true, includeAll(csvColumns(rows, true)));
  assert.deepEqual(
    entries.map((e) => e.title),
    ["Slow Bloom EP", "Vessel Songs", "Ghost"],
  );
  // cells are trimmed; the skipped row drops out entirely
  assert.deepEqual(entries[2], { title: "Ghost", props: [["status", ""], ["cat#", ""]] });
});

test("csvEntries: a row blank in the included columns but filled elsewhere is skipped", () => {
  const cols = csvColumns(ROWS, true).map((c, i) => ({ ...c, include: i === 0 }));
  const entries = csvEntries([...ROWS, ["", "only-excluded", "cells"]], true, cols);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["Slow Bloom EP", "Vessel Songs"],
  );
});

test("csvEntries: nothing included → no entries", () => {
  const cols = csvColumns(ROWS, true).map((c) => ({ ...c, include: false }));
  assert.deepEqual(csvEntries(ROWS, true, cols), []);
});

test("csvEntries tolerates short rows — missing cells read as empty", () => {
  const rows = [["a", "b"], ["1"], ["2", "x", "extra"]];
  const entries = csvEntries(rows, true, includeAll(csvColumns(rows, true)));
  assert.deepEqual(entries, [
    { title: "1", props: [["b", ""], ["Column 3", ""]] },
    { title: "2", props: [["b", "x"], ["Column 3", "extra"]] },
  ]);
});

const names = (cols: CsvColumn[]) => cols.map((c) => c.name);

test("csvSafeColumns suffixes a reserved property name (SUB-559)", () => {
  // `created`/`type`/`title` are the note's own frontmatter — create_full skips
  // them, so these columns used to import empty while the toast said success
  const rows = [["name", "created", "type", "notes"], ["a", "2020-01-01", "album", "x"]];
  const safe = csvSafeColumns(csvColumns(rows, true));
  assert.deepEqual(names(safe), ["name", "created 2", "type 2", "notes"]);
  // and the values follow the new names
  assert.deepEqual(csvEntries(rows, true, safe), [
    { title: "a", props: [["created 2", "2020-01-01"], ["type 2", "album"], ["notes", "x"]] },
  ]);
});

test("csvSafeColumns suffixes reserved database keys too (SUB-562)", () => {
  // `icon`/`home` are create_type's, and it rejected them — killing the import
  const safe = csvSafeColumns(csvColumns([["name", "icon", "home"]], true));
  assert.deepEqual(names(safe), ["name", "icon 2", "home 2"]);
});

test("csvSafeColumns dedupes repeated headers, case-insensitively (SUB-562)", () => {
  // two `Notes` columns are routine in exports; create_type rejected the pair
  const safe = csvSafeColumns(csvColumns([["name", "Notes", "notes", "Notes"]], true));
  assert.deepEqual(names(safe), ["name", "Notes", "notes 2", "Notes 3"]);
});

test("csvSafeColumns leaves the title column and excluded columns alone", () => {
  // a CSV whose first column is `title` is the common case — it becomes the
  // note's title, never a property, so there's nothing to collide with
  assert.deepEqual(names(csvSafeColumns(csvColumns([["title", "status"]], true))), [
    "title",
    "status",
  ]);
  // the title is whichever column is first INCLUDED, not literally the first
  const cols = csvColumns([["skip", "title", "type"]], true).map((c, i) => ({
    ...c,
    include: i !== 0,
  }));
  assert.deepEqual(names(csvSafeColumns(cols)), ["skip", "title", "type 2"]);
});

test("csvSafeColumns doesn't collide with a name its own suffix would take", () => {
  const safe = csvSafeColumns(csvColumns([["name", "type", "type 2"]], true));
  assert.deepEqual(names(safe), ["name", "type 2", "type 2 2"]);
  assert.equal(new Set(names(safe).map((n) => n.toLowerCase())).size, 3);
});

test("dbNameFromFile strips the extension for the dialog prefill", () => {
  assert.equal(dbNameFromFile("Gero QA.csv"), "Gero QA");
  assert.equal(dbNameFromFile("~/Documents/royalties 2026.csv"), "royalties 2026");
  assert.equal(dbNameFromFile("no-extension"), "no-extension");
  assert.equal(dbNameFromFile(".csv"), "Imported");
});
