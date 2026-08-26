import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellSpans,
  editQuoted,
  escapeCell,
  splitRow,
  stripQuotes,
  tableAlignments,
  tableWithAlignment,
  tableWithCell,
  tableWithColumn,
  tableWithRow,
  tableWithoutColumn,
  tableWithoutRow,
} from "./tableedit.ts";
import { slashCommands } from "./slashmenu.ts";

const TABLE = ["| Track | Length |", "| --- | --- |", "| Slug It Out | 6:12 |"].join("\n");

test("splitRow: outer pipes drop out, escaped pipes stay content", () => {
  assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitRow("| a | b"), ["a", "b"]);
  assert.deepEqual(splitRow("| a \\| b | c |"), ["a | b", "c"]);
});

test("splitRow: the backslash run before a pipe decides by parity", () => {
  // odd run — the pipe is content
  assert.deepEqual(splitRow("| a\\|b | c |"), ["a|b", "c"]);
  // even run — an escaped backslash, then a real delimiter
  assert.deepEqual(splitRow("| a\\\\|b | c |"), ["a\\", "b", "c"]);
  // odd again, the pair resolving to one backslash ahead of the literal pipe
  assert.deepEqual(splitRow("| a\\\\\\|b | c |"), ["a\\|b", "c"]);
  // a backslash before anything else is content, not an escape
  assert.deepEqual(splitRow("| \\alpha | b |"), ["\\alpha", "b"]);
});

test("cellSpans: a row closed by an escaped-backslash pipe is closed", () => {
  // `b\|` ends in a literal pipe — the row is still open
  assert.equal(cellSpans("| a | b\\|").closed, false);
  // `b\\|` is an escaped backslash and then the closing pipe
  assert.equal(cellSpans("| a | b\\\\|").closed, true);
});

test("escapeCell: text round-trips through the cell editor unchanged", () => {
  const table = (cell: string) => ["| " + cell + " | z |", "| --- | --- |"].join("\n");
  for (const typed of ["a|b", "a\\b", "a\\|b", "a\\\\|b", "trailing\\"]) {
    const source = table(escapeCell(typed));
    assert.deepEqual(splitRow(source.split("\n")[0]), [typed, "z"], typed);
  }
});

test("tableWithRow: one empty row at the bottom, as wide as the table", () => {
  const next = tableWithRow(TABLE);
  const lines = next.source.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "|  |  |");
  // everything above is untouched — the edit adds, it does not reformat
  assert.equal(lines.slice(0, 3).join("\n"), TABLE);
  // the cursor sits inside the new row's first cell, one space past its pipe
  assert.equal(next.source.slice(next.cursor - 2, next.cursor), "| ");
  assert.equal(next.source.slice(next.cursor), " |  |");
});

test("tableWithColumn: every row grows, the delimiter row stays a delimiter", () => {
  const next = tableWithColumn(TABLE);
  assert.deepEqual(next.source.split("\n"), [
    "| Track | Length |  |",
    "| --- | --- | --- |",
    "| Slug It Out | 6:12 |  |",
  ]);
  // the cursor sits in the new header cell, ready for the column's name
  const head = next.source.split("\n")[0];
  assert.equal(next.cursor, head.length - 2);
  assert.equal(next.source.slice(next.cursor, next.cursor + 2), " |");
});

test("tableWithColumn: a row with no closing pipe gets one before the new cell", () => {
  const ragged = ["| a | b", "| --- | ---", "| 1 | 2"].join("\n");
  assert.deepEqual(tableWithColumn(ragged).source.split("\n"), [
    "| a | b |  |",
    "| --- | --- | --- |",
    "| 1 | 2 |  |",
  ]);
});

test("tableWithColumn: a cell ending in an escaped pipe still gets its own closing pipe", () => {
  // `\|` is content, not the row's closer — read as a closer, the new cell
  // would merge into the last one and the row would fall a column short
  const escaped = ["| a | b |", "| --- | --- |", "| x | y \\|"].join("\n");
  const next = tableWithColumn(escaped);
  const lines = next.source.split("\n");
  assert.deepEqual(lines, ["| a | b |  |", "| --- | --- | --- |", "| x | y \\| |  |"]);
  // still a rectangle, and the escaped pipe is still content
  for (const line of lines) assert.equal(splitRow(line).length, 3);
  assert.deepEqual(splitRow(lines[2]), ["x", "y |", ""]);
});

test("both edits keep the /table scaffold parseable as pipes", () => {
  const scaffold = slashCommands().find((c) => c.name === "table")!.insert;
  for (const next of [tableWithRow(scaffold), tableWithColumn(scaffold)]) {
    const lines = next.source.split("\n");
    // a rectangle: the delimiter row's width is every row's width
    const width = splitRow(lines[1]).length;
    for (const line of lines) assert.equal(splitRow(line).length, width);
    assert.ok(lines[1].split("|").every((c) => c.trim() === "" || /^:?-+:?$/.test(c.trim())));
  }
});

test("tableWithRow: an indented table keeps its indent", () => {
  const indented = TABLE.split("\n")
    .map((l) => "  " + l)
    .join("\n");
  const next = tableWithRow(indented);
  const lines = next.source.split("\n");
  assert.equal(lines[3], "  |  |  |");
  assert.equal(next.source.slice(next.cursor - 2, next.cursor), "| ");
});

test("tableWithRow: trailing whitespace on the last row does not orphan the new one", () => {
  const next = tableWithRow(TABLE + "\n");
  assert.deepEqual(next.source.split("\n").length, 4);
  assert.equal(next.source.split("\n")[3], "|  |  |");
});

test("cellSpans: the spans bracket the cells splitRow reports, and say if the row closed", () => {
  const closed = cellSpans("| a | b |");
  assert.deepEqual(
    closed.cells.map((c) => c.text),
    [" a ", " b "]
  );
  assert.equal(closed.closed, true);
  // the span runs from just past the opening pipe up to the closing one
  assert.equal("| a | b |".slice(closed.cells[1].from, closed.cells[1].to), " b ");

  const open = cellSpans("| a | b");
  assert.equal(open.closed, false);
  assert.equal(open.cells[1].to, "| a | b".length);
});

test("tableWithoutRow: the named body row goes, everything else is untouched", () => {
  const three = [TABLE, "| Nod | 5:01 |"].join("\n");
  assert.deepEqual(tableWithoutRow(three, 2)!.split("\n"), [
    "| Track | Length |",
    "| --- | --- |",
    "| Nod | 5:01 |",
  ]);
  assert.deepEqual(tableWithoutRow(three, 3)!.split("\n"), TABLE.split("\n"));
});

test("tableWithoutRow: the header and the delimiter are not deletable", () => {
  assert.equal(tableWithoutRow(TABLE, 0), null);
  assert.equal(tableWithoutRow(TABLE, 1), null);
  // a row the table doesn't have is a no-op, not a mangled table
  assert.equal(tableWithoutRow(TABLE, 9), null);
});

test("tableWithoutRow: the last body row can go — header plus delimiter still parses", () => {
  const next = tableWithoutRow(TABLE, 2)!;
  assert.deepEqual(next.split("\n"), ["| Track | Length |", "| --- | --- |"]);
});

test("tableWithoutColumn: one column out of every row, spacing elsewhere preserved", () => {
  const wide = ["| a | b | c |", "| --- | :---: | ---: |", "|1|2|3|"].join("\n");
  assert.deepEqual(tableWithoutColumn(wide, 1)!.split("\n"), [
    "| a | c |",
    "| --- | ---: |",
    "|1|3|",
  ]);
  // dropping the first column keeps the row's opening pipe
  assert.deepEqual(tableWithoutColumn(wide, 0)!.split("\n"), [
    "| b | c |",
    "| :---: | ---: |",
    "|2|3|",
  ]);
  // and the last takes the closing pipe with it, leaving the row closed
  assert.deepEqual(tableWithoutColumn(wide, 2)!.split("\n"), [
    "| a | b |",
    "| --- | :---: |",
    "|1|2|",
  ]);
});

test("tableWithoutColumn: the only column stays — a table with none is not a table", () => {
  const single = ["| a |", "| --- |", "| 1 |"].join("\n");
  assert.equal(tableWithoutColumn(single, 0), null);
  assert.equal(tableWithoutColumn(TABLE, 5), null);
});

test("tableWithoutColumn: an escaped pipe stays content when its neighbour goes", () => {
  const escaped = ["| a | b |", "| --- | --- |", "| x \\| y | z |"].join("\n");
  const next = tableWithoutColumn(escaped, 1)!;
  assert.deepEqual(next.split("\n"), ["| a |", "| --- |", "| x \\| y |"]);
  assert.deepEqual(splitRow(next.split("\n")[2]), ["x | y"]);
});

test("tableWithoutColumn: an unclosed row loses its own opening pipe with the last cell", () => {
  const ragged = ["| a | b", "| --- | ---", "| 1 | 2"].join("\n");
  assert.deepEqual(tableWithoutColumn(ragged, 1)!.split("\n"), ["| a", "| ---", "| 1"]);
});

test("tableWithoutColumn: a pipeless two-column table keeps its pipes and stays a table", () => {
  const pipeless = ["Track | Length", "--- | ---", "Nod | 5:01"].join("\n");
  // without the re-pipe every line here would come out bare ("Track"), the
  // table would stop parsing and the header would read as a setext heading
  assert.deepEqual(tableWithoutColumn(pipeless, 1)!.split("\n"), ["| Track |", "| --- |", "| Nod |"]);
  assert.deepEqual(tableWithoutColumn(pipeless, 0)!.split("\n"), [
    "| Length |",
    "| --- |",
    "| 5:01 |",
  ]);
});

test("tableWithoutColumn: a pipeless table with columns to spare keeps its own spacing", () => {
  const pipeless = ["A | B | C", "--- | --- | ---", "1 | 2 | 3"].join("\n");
  // two columns still have a pipe between them: nothing to rescue, so the
  // rows are left exactly as the user spaced them
  assert.deepEqual(tableWithoutColumn(pipeless, 1)!.split("\n"), ["A | C", "--- | ---", "1 | 3"]);
});

test("tableWithoutColumn: a pipeless table indented in a list keeps its indent", () => {
  const nested = ["  Track | Length", "  --- | ---", "  Nod | 5:01"].join("\n");
  assert.deepEqual(tableWithoutColumn(nested, 1)!.split("\n"), [
    "  | Track |",
    "  | --- |",
    "  | Nod |",
  ]);
});

test("tableWithoutColumn: an escaped pipe alone in a row is text, so the row is re-piped", () => {
  const pipeless = ["a \\| b | B", "--- | ---", "1 | 2"].join("\n");
  const next = tableWithoutColumn(pipeless, 1)!;
  assert.deepEqual(next.split("\n"), ["| a \\| b |", "| --- |", "| 1 |"]);
  assert.deepEqual(splitRow(next.split("\n")[0]), ["a | b"]);
});

test("tableAlignments: `---` is unset, the colons are the three settings", () => {
  const marked = ["| a | b | c | d |", "| --- | :--- | :---: | ---: |"].join("\n");
  assert.deepEqual(tableAlignments(marked), [null, "left", "center", "right"]);
});

test("tableWithAlignment: only the delimiter cell changes, dash count kept", () => {
  const next = tableWithAlignment(TABLE, 1, "center")!;
  assert.deepEqual(next.split("\n"), [
    "| Track | Length |",
    "| --- | :---: |",
    "| Slug It Out | 6:12 |",
  ]);
  assert.deepEqual(tableAlignments(next), [null, "center"]);
  // and clearing it puts the plain delimiter back
  assert.deepEqual(tableWithAlignment(next, 1, null)!.split("\n"), TABLE.split("\n"));
});

test("tableWithAlignment: a long delimiter keeps its width, a short one is padded to three", () => {
  const long = ["| a | b |", "| ------- | -- |"].join("\n");
  assert.equal(tableWithAlignment(long, 0, "right")!.split("\n")[1], "| -------: | -- |");
  assert.equal(tableWithAlignment(long, 1, "left")!.split("\n")[1], "| ------- | :--- |");
});

test("tableWithAlignment: a column the table doesn't have is refused", () => {
  assert.equal(tableWithAlignment(TABLE, 4, "right"), null);
  assert.equal(tableWithAlignment("| a |", 0, "right"), null);
});

test("escapeCell: pipes and newlines can't reshape the table from inside a cell", () => {
  assert.equal(escapeCell("a | b"), "a \\| b");
  assert.equal(escapeCell("two\nlines"), "two lines");
  assert.equal(escapeCell("  padded  "), "padded");
});

test("tableWithCell: one cell's text, every other character where it was", () => {
  const next = tableWithCell(TABLE, 2, 1, "7:40")!;
  assert.deepEqual(next.split("\n"), [
    "| Track | Length |",
    "| --- | --- |",
    "| Slug It Out | 7:40 |",
  ]);
  // an emptied cell keeps its pipes apart
  assert.equal(tableWithCell(TABLE, 2, 0, "")!.split("\n")[2], "|  | 6:12 |");
  // and a header cell is editable, the delimiter is not
  assert.equal(tableWithCell(TABLE, 0, 0, "Title")!.split("\n")[0], "| Title | Length |");
  assert.equal(tableWithCell(TABLE, 1, 0, "nope"), null);
});

test("tableWithCell: a pipe typed into a cell is escaped, not a new column", () => {
  const next = tableWithCell(TABLE, 2, 0, "a | b")!;
  const row = next.split("\n")[2];
  assert.equal(row, "| a \\| b | 6:12 |");
  assert.deepEqual(splitRow(row), ["a | b", "6:12"]);
});

test("tableWithCell: coordinates the table no longer has are refused", () => {
  assert.equal(tableWithCell(TABLE, 9, 0, "x"), null);
  assert.equal(tableWithCell(TABLE, 2, 7, "x"), null);
});

const QUOTED = ["> | Track | Length |", "> | --- | --- |", "> | Slug It Out | 6:12 |"].join("\n");

test("stripQuotes: quote marker runs come off, cell content stays (SUB-1274)", () => {
  assert.equal(stripQuotes("> | a | b |"), "| a | b |");
  assert.equal(stripQuotes("> > | a \\| b |"), "| a \\| b |");
  assert.equal(stripQuotes(" > | a |"), "| a |");
  // a ">" inside a cell is content, not a marker
  assert.equal(stripQuotes("| a > b |"), "| a > b |");
});

test("editQuoted: a grown row stays inside the quote, cursor behind the marks (SUB-1274)", () => {
  const next = editQuoted(QUOTED, tableWithRow);
  const lines = next.source.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "> |  |  |");
  assert.equal(lines.slice(0, 3).join("\n"), QUOTED);
  // the cursor sits inside the new row's first cell, past the quote mark
  assert.equal(next.source.slice(next.cursor - 2, next.cursor), "| ");
  assert.equal(next.source.slice(next.cursor), " |  |");
});

test("editQuoted: a grown column grows every quoted line (SUB-1274)", () => {
  const next = editQuoted(QUOTED, tableWithColumn);
  assert.deepEqual(next.source.split("\n"), [
    "> | Track | Length |  |",
    "> | --- | --- | --- |",
    "> | Slug It Out | 6:12 |  |",
  ]);
  const head = next.source.split("\n")[0];
  assert.equal(next.cursor, head.length - 2);
  assert.equal(next.source.slice(next.cursor, next.cursor + 2), " |");
});

test("editQuoted: nested quotes keep their depth, unquoted tables pass through (SUB-1274)", () => {
  const nested = ["> > | a | b |", "> > | --- | --- |", "> > | 1 | 2 |"].join("\n");
  const next = editQuoted(nested, tableWithRow);
  assert.equal(next.source.split("\n")[3], "> > |  |  |");
  assert.deepEqual(editQuoted(TABLE, tableWithRow), tableWithRow(TABLE));
});
