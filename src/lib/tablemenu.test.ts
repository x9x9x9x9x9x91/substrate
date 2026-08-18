import { test } from "node:test";
import assert from "node:assert/strict";
import { tableActions, tableCellAtOffset } from "./tablemenu.ts";
import { splitRow, tableAlignments } from "./tableedit.ts";

const TABLE = ["| Track | Length |", "| --- | --- |", "| Slug It Out | 6:12 |"].join("\n");

function byId(source: string, row: number, col: number, rendered = true) {
  const map = new Map(tableActions(source, row, col, { rendered }).map((a) => [a.id, a]));
  return map;
}

test("tableCellAtOffset: the cursor's own row and column, with no grid on screen", () => {
  // "| Track | Length |" — inside "Track" is (0, 0), inside "Length" is (0, 1)
  assert.deepEqual(tableCellAtOffset(TABLE, 4), { row: 0, col: 0 });
  assert.deepEqual(tableCellAtOffset(TABLE, 12), { row: 0, col: 1 });
  // the body row is line 2; its second cell holds the running time
  const body = TABLE.indexOf("6:12");
  assert.deepEqual(tableCellAtOffset(TABLE, body), { row: 2, col: 1 });
  // the line's own start sits in the first cell, its end in the last
  assert.deepEqual(tableCellAtOffset(TABLE, TABLE.indexOf("| Slug")), { row: 2, col: 0 });
  assert.deepEqual(tableCellAtOffset(TABLE, TABLE.length), { row: 2, col: 1 });
});

test("tableCellAtOffset: the delimiter row is found like any other", () => {
  assert.deepEqual(tableCellAtOffset(TABLE, TABLE.indexOf("| --- |") + 3), { row: 1, col: 0 });
});

test("the grow actions carry the cursor, the rest leave the selection alone", () => {
  const actions = byId(TABLE, 2, 0);
  assert.ok(actions.get("add-row")!.cursor !== undefined);
  assert.ok(actions.get("add-column")!.cursor !== undefined);
  for (const id of ["delete-row", "delete-column", "align-left", "align-center", "align-right"]) {
    assert.equal(actions.get(id)!.cursor, undefined, id);
  }
});

test("delete row is refused on the header and the delimiter, offered on a body row", () => {
  assert.equal(byId(TABLE, 0, 0).get("delete-row")!.source, null);
  assert.equal(byId(TABLE, 1, 0).get("delete-row")!.source, null);
  const ok = byId(TABLE, 2, 0).get("delete-row")!.source;
  assert.deepEqual(ok!.split("\n"), ["| Track | Length |", "| --- | --- |"]);
});

test("delete column is refused when it would leave the table with none", () => {
  const single = ["| a |", "| --- |", "| 1 |"].join("\n");
  assert.equal(byId(single, 2, 0).get("delete-column")!.source, null);
  assert.equal(splitRow(byId(TABLE, 2, 1).get("delete-column")!.source!.split("\n")[0]).length, 1);
});

test("the column's current alignment is marked, and choosing it again clears it", () => {
  const plain = byId(TABLE, 2, 1);
  assert.equal(plain.get("align-center")!.current, false);
  const centred = plain.get("align-center")!.source!;
  assert.deepEqual(tableAlignments(centred), [null, "center"]);

  const marked = byId(centred, 2, 1);
  assert.equal(marked.get("align-center")!.current, true);
  // the marked row toggles back to markdown's unset delimiter
  assert.deepEqual(tableAlignments(marked.get("align-center")!.source!), [null, null]);
  // while the other two still just set
  assert.deepEqual(tableAlignments(marked.get("align-right")!.source!), [null, "right"]);
});

test("in-place cell editing is offered on the grid only, and never on the delimiter", () => {
  assert.ok(byId(TABLE, 2, 0).get("cell")!.editCell);
  assert.ok(byId(TABLE, 0, 0).get("cell")!.editCell);
  assert.equal(byId(TABLE, 1, 0).get("cell"), undefined);
  // with the cursor in the table there is no grid — the source is already open
  assert.equal(byId(TABLE, 2, 0, false).get("cell"), undefined);
});

test("every action either rewrites the whole table or says it cannot", () => {
  for (const action of tableActions(TABLE, 2, 1, { rendered: true })) {
    if (action.editCell) continue;
    assert.ok(
      action.source === null || action.source.startsWith("| Track |") || action.id === "delete-column",
      action.id
    );
  }
});

test("a quoted table refuses every rewrite instead of stripping its quote", () => {
  // the renderer counts the "> " marker as a first cell, so a rewrite here
  // writes one column to the left of what was clicked — and dropping column 0
  // takes the quote markers off every line
  const quoted = ["> | Track | Length |", "> | --- | --- |", "> | Nod | 5:01 |"].join("\n");
  const actions = tableActions(quoted, 2, 1, { rendered: true });
  for (const action of actions) {
    if (action.editCell) assert.equal(action.disabled, true, action.id);
    else assert.equal(action.source, null, action.id);
  }
  // every action the plain table offers is still on the list, greyed rather
  // than missing — the table's own shape is what explains the refusal
  assert.deepEqual(
    actions.map((a) => a.id),
    tableActions(TABLE, 2, 1, { rendered: true }).map((a) => a.id)
  );
  // and no alignment is ticked: the tick would be about the wrong column
  assert.equal(
    actions.every((a) => !a.current),
    true
  );
});

test("an indented quoted table is refused too, and an unquoted one is not", () => {
  const nested = ["  > | a | b |", "  > | --- | --- |", "  > | 1 | 2 |"].join("\n");
  assert.equal(tableActions(nested, 2, 1, { rendered: true }).every((a) => a.source === null), true);
  // a cell whose text merely starts with ">" is not a quote
  const arrow = ["| > | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
  assert.ok(tableActions(arrow, 2, 1, { rendered: true }).find((a) => a.id === "add-row")!.source);
});
