/** The one list of things you can do to a markdown table, and which cell you
 * are doing them to. Every entry is a whole rewritten table (or null when the
 * shape refuses it), so the caller dispatches one document change and never
 * has to know pipes — and the same list feeds the right-click menu and the
 * keyboard one, which is what keeps the two from drifting apart. */

import {
  cellSpans,
  tableAlignments,
  tableWithAlignment,
  tableWithColumn,
  tableWithRow,
  tableWithoutColumn,
  tableWithoutRow,
  type CellAlign,
} from "./tableedit.ts";

export interface TableAction {
  id: string;
  label: string;
  /** The table this action writes, or null when it can't run where the menu
   * was opened — the row still shows, greyed, so the table's own shape is
   * what explains the refusal (the last column can't go; the header is not a
   * body row). */
  source: string | null;
  /** Where the cursor belongs inside the new source. Only the two growing
   * actions set it: they exist to be typed into. Everything else leaves the
   * selection where it was, so a table edited from the rendered grid stays
   * rendered instead of springing open as pipes. */
  cursor?: number;
  danger?: boolean;
  separatorAbove?: boolean;
  /** This is the column's current alignment — selecting it clears it. */
  current?: boolean;
  /** Not a rewrite: hand this cell to the in-place editor. */
  editCell?: boolean;
  /** Refused for a reason that isn't about this action's own rewrite — a
   * quoted table, where every column index is one off what was clicked. Shown
   * greyed like the rest, and never applied. */
  disabled?: boolean;
}

/** Whether the table sits inside a blockquote or a callout. Its source keeps
 * the `> ` prefixes, and the row scanner reads that marker as a first cell —
 * so the column the menu was opened on is one to the left of the column it
 * would write, and dropping "column 0" lifts the table out of its quote
 * entirely. Until the renderer stops counting the marker as a cell, the menu
 * refuses to rewrite these tables: shown and greyed, like the header's own
 * Delete row, rather than silently wrong. */
function isQuoted(source: string): boolean {
  return /^[ \t]*>/.test(source.split("\n")[0] ?? "");
}

/** The cell an offset inside the table's own source falls in — how the
 * keyboard finds the row and column the cursor is sitting in, with no grid on
 * screen to point at (a table with the cursor in it renders as pipes). */
export function tableCellAtOffset(source: string, offset: number): { row: number; col: number } {
  const lines = source.split("\n");
  let start = 0;
  let row = 0;
  while (row < lines.length - 1 && offset > start + lines[row].length) {
    start += lines[row].length + 1;
    row++;
  }
  const within = offset - start;
  const { cells } = cellSpans(lines[row]);
  if (cells.length === 0) return { row, col: 0 };
  const col = cells.findIndex((c) => within <= c.to);
  return { row, col: col === -1 ? cells.length - 1 : col };
}

const ALIGNMENTS: { align: Exclude<CellAlign, null>; label: string }[] = [
  { align: "left", label: "Align left" },
  { align: "center", label: "Align centre" },
  { align: "right", label: "Align right" },
];

/**
 * Everything the table at `source` can be asked to do about the cell at
 * (`row`, `col`).
 *
 * `rendered` is whether the grid is on screen. It gates in-place cell editing
 * and nothing else: with the cursor inside the table there is no grid, the
 * source is already open under the cursor, and "edit this cell" would mean
 * putting a text box on top of the text you are in.
 */
export function tableActions(
  source: string,
  row: number,
  col: number,
  { rendered }: { rendered: boolean }
): TableAction[] {
  const quoted = isQuoted(source);
  // a quoted table refuses every rewrite, growing included: the new row would
  // be written without the `> ` the rest of the table carries and would drop
  // out of the quote it was added to
  const rewrite = (next: string | null) => (quoted ? null : next);
  const grown = tableWithRow(source);
  const widened = tableWithColumn(source);
  const alignment = tableAlignments(source)[col] ?? null;
  const actions: TableAction[] = [];
  // the delimiter row is markdown's, not the user's — there is no text in it
  // to edit, only an alignment, which has its own rows below
  if (rendered && row !== 1) {
    actions.push({
      id: "cell",
      label: "Edit cell",
      source: null,
      editCell: true,
      disabled: quoted,
    });
  }
  actions.push(
    {
      id: "add-row",
      label: "Add row",
      source: rewrite(grown.source),
      cursor: grown.cursor,
      separatorAbove: actions.length > 0,
    },
    {
      id: "add-column",
      label: "Add column",
      source: rewrite(widened.source),
      cursor: widened.cursor,
    },
    {
      id: "delete-row",
      label: "Delete row",
      source: rewrite(tableWithoutRow(source, row)),
      danger: true,
      separatorAbove: true,
    },
    {
      id: "delete-column",
      label: "Delete column",
      source: rewrite(tableWithoutColumn(source, col)),
      danger: true,
    }
  );
  for (const { align, label } of ALIGNMENTS) {
    const current = alignment === align;
    actions.push({
      id: `align-${align}`,
      label,
      // a marked entry toggles: choosing the alignment a column already has
      // puts the plain `---` delimiter back
      source: rewrite(tableWithAlignment(source, col, current ? null : align)),
      // on a quoted table the column indices are off by the quote marker, so
      // a tick would be claiming something about the wrong column
      current: current && !quoted,
      separatorAbove: align === "left",
    });
  }
  return actions;
}
