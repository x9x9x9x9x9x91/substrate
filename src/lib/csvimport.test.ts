import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CSV_KINDS,
  csvCellValue,
  csvColumns,
  csvEntries,
  csvSafeColumns,
  csvSampleCell,
  csvSelectOptions,
  dbNameFromFile,
  type CsvColumn,
} from "./csvimport.ts";
import { setNumberLocale } from "./numberLocale.ts";

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

test("csvCellValue stores a date column the way the date menu commits one", () => {
  // a spreadsheet writes the author's dialect; the calendar, the sort and
  // every date filter read ISO — so the import normalizes at the boundary
  assert.equal(csvCellValue("15.08.2026", "date"), "2026-08-15");
  assert.equal(csvCellValue("Aug 15 2026", "date"), "2026-08-15");
  assert.equal(csvCellValue("2026-08-15", "date"), "2026-08-15");
  // a time survives in the day HH:MM shape DateMenu commits
  assert.equal(csvCellValue("15.08.2026 9:30", "date"), "2026-08-15 09:30");
  // text that is no date at all is stored exactly as written — the import
  // is the only copy, so it never drops what it can't read
  assert.equal(csvCellValue("whenever", "date"), "whenever");
  assert.equal(csvCellValue("", "date"), "");
});

test("csvCellValue stores a number column canonically, junk as typed", () => {
  setNumberLocale("de-DE");
  assert.equal(csvCellValue("1.234,56", "number"), "1234.56");
  assert.equal(csvCellValue(" 42 ", "number"), "42");
  assert.equal(csvCellValue("ask", "number"), "ask");
  // and the same text under another dial reads that dial's grouping
  setNumberLocale("en-US");
  assert.equal(csvCellValue("1,234.56", "number"), "1234.56");
});

test("a number cell is read through the dial, which is what the preview is for", () => {
  // the dial is app-wide state, so each test that depends on one sets it —
  // and this is the misread the import card's sample preview exists to show:
  // the same three characters mean a thousand under one dial and one under
  // the other, and nothing in the file says which was meant
  setNumberLocale("en-US");
  assert.equal(csvCellValue("1,234", "number"), "1234");
  setNumberLocale("de-DE");
  assert.equal(csvCellValue("1,234", "number"), "1.234");
});

test("csvCellValue leaves the string kinds verbatim", () => {
  // text/select/url/email/phone all store the cell as written — only the
  // schema entry differs, and a select's options accrete from the values
  for (const kind of ["text", "select", "url", "email", "phone"] as const) {
    assert.equal(csvCellValue(" 1.234,56 ", kind), "1.234,56");
    assert.equal(csvCellValue(" 15.08.2026 ", kind), "15.08.2026");
  }
  // an unset kind is the pre-choice behaviour: trimmed text
  assert.equal(csvCellValue(" 15.08.2026 ", undefined), "15.08.2026");
});

test("csvEntries stores each prop through its own column's kind", () => {
  setNumberLocale("de-DE"); // the dial the "1.234,56" below is written in
  const rows = [
    ["title", "due", "fee", "stage"],
    ["Slow Bloom EP", "15.08.2026", "1.234,56", "mastering"],
  ];
  const cols = csvSafeColumns(
    csvColumns(rows, true).map((c, i) => ({
      ...c,
      kind: (["text", "date", "number", "select"] as const)[i],
    })),
  );
  assert.deepEqual(csvEntries(rows, true, cols), [
    {
      title: "Slow Bloom EP",
      props: [["due", "2026-08-15"], ["fee", "1234.56"], ["stage", "mastering"]],
    },
  ]);
});

test("csvEntries: the title column's kind never touches the title", () => {
  // the first included column becomes the note's title, which is prose —
  // a date-kinded first column must not rewrite it
  const rows = [["when", "note"], ["15.08.2026", "x"]];
  const cols = csvColumns(rows, true).map((c) => ({ ...c, kind: "date" as const }));
  assert.deepEqual(csvEntries(rows, true, cols), [
    { title: "15.08.2026", props: [["note", "x"]] },
  ]);
});

test("csvSafeColumns carries each column's kind through the rename", () => {
  const cols = csvColumns([["name", "created"]], true).map((c, i) => ({
    ...c,
    kind: (["text", "date"] as const)[i],
  }));
  const safe = csvSafeColumns(cols);
  assert.deepEqual(names(safe), ["name", "created 2"]);
  assert.deepEqual(safe.map((c) => c.kind), ["text", "date"]);
});

test("csvSelectOptions is the column's vocabulary, ordered like the schema editor's", () => {
  const rows = [
    ["title", "stage"],
    ["A", "mastering"],
    ["B", "in review"],
    ["C", "mastering"],
    ["D", ""],
    ["E", "Mastering"],
  ];
  const cols = csvSafeColumns(
    csvColumns(rows, true).map((c, i) => ({ ...c, kind: i === 1 ? ("select" as const) : undefined })),
  );
  const entries = csvEntries(rows, true, cols);
  // distinct values, blanks dropped, sorted the way App's usedValues sorts
  // the option list it prefills the schema editor with (numeric, case-blind)
  assert.deepEqual(csvSelectOptions(entries, "stage"), ["in review", "mastering", "Mastering"]);
  // spellings differing only in case ride through here and collapse on
  // write, exactly as the editor's own save collapses them
  assert.deepEqual(csvSelectOptions(entries, "nothing-of-that-name"), []);
});

test("csvSelectOptions sorts numerically, like every other value list", () => {
  const rows = [
    ["title", "take"],
    ["A", "take 10"],
    ["B", "take 2"],
    ["C", "take 1"],
  ];
  const entries = csvEntries(rows, true, csvColumns(rows, true));
  assert.deepEqual(csvSelectOptions(entries, "take"), ["take 1", "take 2", "take 10"]);
});

test("csvSampleCell reads the first cell a column actually has something in", () => {
  const rows = [
    ["title", "fee", "note"],
    ["Slow Bloom EP", "", ""],
    ["Vessel Songs", " 1.234,56 ", ""],
  ];
  // the header row is not a sample — the preview has to show a row that is
  // really being imported
  assert.equal(csvSampleCell(rows, true, 1), "1.234,56");
  assert.equal(csvSampleCell(rows, false, 1), "fee");
  // an empty column has nothing to preview
  assert.equal(csvSampleCell(rows, true, 2), "");
  assert.equal(csvSampleCell(rows, true, 9), "");
});

test("the CSV kind list offers only kinds a string cell can honestly become", () => {
  // checkbox wants a YAML bool and multi a YAML list, neither of which
  // vault_create can write from a string cell; relation needs a target
  // database, rollup stores nothing, and file names a path in the vault
  for (const excluded of ["checkbox", "multi", "relation", "rollup", "file"]) {
    assert.ok(
      !(CSV_KINDS as readonly string[]).includes(excluded),
      `${excluded} cannot be imported from a flat cell`,
    );
  }
  assert.deepEqual([...CSV_KINDS], ["text", "select", "number", "date", "url", "email", "phone"]);
});

test("dbNameFromFile strips the extension for the dialog prefill", () => {
  assert.equal(dbNameFromFile("Gero QA.csv"), "Gero QA");
  assert.equal(dbNameFromFile("~/Documents/royalties 2026.csv"), "royalties 2026");
  assert.equal(dbNameFromFile("no-extension"), "no-extension");
  assert.equal(dbNameFromFile(".csv"), "Imported");
});
