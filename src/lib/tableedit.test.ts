import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRow, tableWithColumn, tableWithRow } from "./tableedit.ts";
import { slashCommands } from "./slashmenu.ts";

const TABLE = ["| Track | Length |", "| --- | --- |", "| Slug It Out | 6:12 |"].join("\n");

test("splitRow: outer pipes drop out, escaped pipes stay content", () => {
  assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitRow("| a | b"), ["a", "b"]);
  assert.deepEqual(splitRow("| a \\| b | c |"), ["a | b", "c"]);
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
