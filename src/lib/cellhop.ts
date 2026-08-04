/* The spreadsheet keyboard grammar's arithmetic (SUB-947).

   Filling a column used to cost one Enter to commit and another to re-open
   the next cell. Enter/Tab now commit AND carry the editor to the next cell,
   which turns "which cell is next" into a real question: rollup columns are
   derived (SUB-678) and hold no editor, so a hop has to walk past them, and
   Tab has to wrap rows the way a spreadsheet does.

   Pure TS, no DOM/React: runs in the app and under `node --test`. */

import type { PropKind } from "./types.ts";

export type HopDir = "down" | "up" | "right" | "left";

/** Coordinates in the table's focus space: `c` 0 is the title column, data
    columns run 1..cols; `r` indexes the visible rows. */
export interface Cell {
  c: number;
  r: number;
}

export interface HopGrid {
  /** how many DATA columns the view shows (the title column is not one) */
  cols: number;
  rows: number;
  /** the kind of data column `i` (0-based over data columns, so `c - 1`) */
  kindAt: (i: number) => PropKind | undefined;
}

/** A derived cell holds no value of its own (SUB-678), so the commit-and-move
    hop steps over it rather than opening an editor that could not commit. */
function inert(grid: HopGrid, c: number): boolean {
  return grid.kindAt(c - 1) === "rollup";
}

/** Where a commit-and-move lands, or null when the grammar says stop.

    Vertical (Enter / Shift-Enter) stays in its column and stops at the last
    and first row — a column is one kind throughout, so nothing to skip.

    Horizontal (Tab / Shift-Tab) walks the data columns and wraps at the ends
    into the next/previous row, spreadsheet-style; it stops at the very last
    and very first data cell of the table. Rollup columns are walked past. */
export function nextEditableCell(from: Cell, dir: HopDir, grid: HopGrid): Cell | null {
  if (grid.cols < 1 || grid.rows < 1) return null;
  if (dir === "down" || dir === "up") {
    const r = from.r + (dir === "down" ? 1 : -1);
    if (r < 0 || r >= grid.rows) return null;
    if (from.c < 1 || from.c > grid.cols) return null;
    return { c: from.c, r };
  }
  const step = dir === "right" ? 1 : -1;
  // start from the first data column when the walk begins on the title cell,
  // so a Tab out of a title never dead-ends
  let c = from.c < 1 ? (step > 0 ? 0 : grid.cols + 1) : from.c;
  let r = from.r;
  // bounded by the grid: a table whose every column is a rollup terminates
  // here instead of walking forever
  for (let guard = grid.cols * grid.rows + grid.cols; guard > 0; guard--) {
    c += step;
    if (c > grid.cols) {
      c = 1;
      r += 1;
    } else if (c < 1) {
      c = grid.cols;
      r -= 1;
    }
    if (r < 0 || r >= grid.rows) return null;
    if (!inert(grid, c)) return { c, r };
  }
  return null;
}

/** Does this keystroke start a type-to-replace edit? One printable character,
    no command/control/alt chord — the keys that would otherwise land nowhere
    on a focused cell. Space is excluded: it activates, like Enter. */
export function isPrintableKey(e: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // `key` is the produced character for printable keys and a name ("Enter",
  // "F2", "ArrowDown") for everything else — length is the whole test, once
  // the space bar is spoken for
  return [...e.key].length === 1 && e.key !== " ";
}
