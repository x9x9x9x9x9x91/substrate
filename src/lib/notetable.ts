// One reader for "a table living in a note": the csv fence, its header row,
// and name-based column lookup — the shape every table-backed pane had been
// re-deriving by hand from findFence + parseCsv + a private headerIdx copy.
//
// The contract those copies all shared, kept exactly:
//   * no csv fence at all → the caller decides (null here)
//   * a fence that parses to nothing → header row absent, so every column
//     lookup misses and the caller's own required-column guard returns empty
//   * the header row is dropped from `rows`; a data row's index is its
//     position in `rows`, which is the delete/write handle panes persist
//   * cells are returned as written; `text` trims for display, `raw` doesn't
//     (number parsing tolerances differ per pane and stay the pane's own)
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { findFence, parseCsv, type Fence } from "./sheet.ts";

/** Index of the first header matching any of `names`, case- and
    whitespace-insensitively; -1 when none does. Standalone for writers, which
    work on a header row they may have just created or grown — see
    `NoteTable.col` for the reader's form and the several-names rule. */
export function headerIndex(headers: readonly string[], ...names: string[]): number {
  const want = names.map((n) => n.trim().toLowerCase());
  return headers.findIndex((h) => want.includes(h.trim().toLowerCase()));
}

export interface NoteTable {
  /** the csv fence the table was read from — writers splice against it */
  fence: Fence;
  /** header cells as written (empty when the fence parsed to no rows) */
  headers: string[];
  /** DATA rows only, sheet order — `rows[i]` is the row panes call `idx: i` */
  rows: string[][];
  /** Index of the first header matching any of `names`, case- and
      whitespace-insensitively; -1 when none does. Several names means
      several accepted spellings of ONE column (the food DB's `g` /
      `g_per_unit`), resolved in HEADER order, not argument order — the sheet
      owner's column wins when a hand-edited sheet carries both. */
  col(...names: string[]): number;
  /** Trimmed cell, "" when the column is absent or the row is short. */
  text(row: string[], col: number): string;
  /** Cell exactly as written, "" when absent — for callers whose own number
      parser owns the whitespace rule. */
  raw(row: string[], col: number): string;
  /** header + data rows, the shape replaceCsvRows takes back. */
  allRows(): string[][];
}

/** The note's csv table, or null when the note has no csv fence.

    A fence that parses to zero rows still yields a table (with no headers):
    the fence is real and a writer may need it, and every reader's
    required-column guard already turns "no headers" into "nothing to show". */
export function readNoteTable(body: string): NoteTable | null {
  const fence = findFence(body, "csv");
  if (!fence) return null;
  const parsed = parseCsv(fence.inner);
  const headers = parsed.length > 0 ? parsed[0] : [];
  const rows = parsed.slice(1);
  return {
    fence,
    headers,
    rows,
    col(...names: string[]): number {
      return headerIndex(headers, ...names);
    },
    text(row: string[], col: number): string {
      return col >= 0 ? (row[col] ?? "").trim() : "";
    },
    raw(row: string[], col: number): string {
      return col >= 0 ? row[col] ?? "" : "";
    },
    allRows(): string[][] {
      return parsed.length > 0 ? [headers, ...rows] : [];
    },
  };
}
