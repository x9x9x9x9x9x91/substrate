/* What one cell of an inline ```view table means.

   The widget that renders that table lives in editor-widgets.ts, which pulls
   in CodeMirror and the React editor host — so nothing in there can be
   exercised under `node --test`. These three questions are pure, and they are
   the ones a read-only column turns on: what model does this cell have, does
   it open an editor, does it accept a write. Keeping them here makes the
   guards testable without a DOM.

   Pure TS, no DOM imports: runs in the app and under `node --test`. */

import { normalizeNumberInput } from "./aggregate.ts";
import { embedPillColor } from "./cellpill.ts";
import { cellModel, cellOpensEditor, type CellModel } from "./cellmodel.ts";
import type { EmbedResult } from "./embeds.ts";

/** Is this column a lookup through a relation rather than one of
    this row's own props? */
export function isJoinedColumn(result: EmbedResult, column: string): boolean {
  return !("error" in result) && (result.joins?.includes(column) ?? false);
}

/** A joined cell has no base-row model to derive: its value lives on ANOTHER
    row, so reading this row's props and this database's schema for it is
    meaningless. Asking anyway happens to return an empty, kindless model
    today, which paints correctly by luck; skipping the derivation makes that
    correctness structural. The text still comes from `row.cells`, which the
    query already filled from the target. */
const JOINED_CELL: CellModel = {
  actualKey: "",
  val: "",
  schema: undefined,
  kind: undefined,
  list: [],
  checked: false,
};

/** The cell model for one column of the inline table — the base row's, or the
    inert stand-in for a joined column. */
export function viewCellModel(
  result: Exclude<EmbedResult, { error: string }>,
  props: Record<string, unknown>,
  column: string
): CellModel {
  if (isJoinedColumn(result, column)) return JOINED_CELL;
  return cellModel(props, column, result.typeSchema);
}

/** What a cell LOOKS like: a checkbox box, an option pill, or plain text. */
export type CellPaint =
  | { kind: "checkbox"; checked: boolean }
  | { kind: "pill"; color: string }
  | { kind: "text" };

/** How one cell of the inline table paints.

    Deliberately blind to whether the surface can write: look is a property of
    the VALUE, so a read-only hub shows the same box and the same pill as an
    editable one, and the two can't drift into showing a checkbox as the raw
    string `true`. That independence is the whole point of the question living
    here — there is no `edit` to pass in, and no way to render one surface's
    paint through the other's rules. A joined column paints flat:
    its value belongs to another type, so this database's options must not
    colour it. */
export function viewCellPaint(
  result: Exclude<EmbedResult, { error: string }>,
  column: string,
  text: string,
  model: CellModel
): CellPaint {
  if (isJoinedColumn(result, column)) return { kind: "text" };
  if (model.kind === "checkbox") return { kind: "checkbox", checked: model.checked };
  const color = embedPillColor(result.typeSchema, column, text);
  return color === undefined ? { kind: "text" } : { kind: "pill", color };
}

/** Whether a click on this cell opens an editor. The kind rule is the
    database table's (`cellOpensEditor`); on top of it a joined column
     is read-only, because its value is a stored property of ANOTHER
    row — the same reason a rollup cell is inert. */
export function viewCellEditable(
  result: EmbedResult,
  column: string,
  model: CellModel
): boolean {
  if ("error" in result) return false;
  if (isJoinedColumn(result, column)) return false;
  return cellOpensEditor(model.kind);
}

/** Whether a cell accepts a WRITE. Checkboxes never "open an editor" — they
    toggle in place — so the editability question splits in two: the
    read-only-ness is shared, the kind rule is not. A checkbox toggle bypasses
    the editor entirely, so guarding only the paint and the editor-opening
    click would leave that write open. */
export function viewCellWritable(result: EmbedResult, column: string): boolean {
  return !("error" in result) && !isJoinedColumn(result, column);
}

/** A number column stores what the app can read back, not the keystrokes —
    the same normalization the database pane commits through. Shared so the
    editor's fence and a hub/workbook embed commit a typed number identically
    instead of through two copies. */
export function commitCellText(value: string, model: CellModel): string {
  return model.kind === "number" ? normalizeNumberInput(value) : value;
}
