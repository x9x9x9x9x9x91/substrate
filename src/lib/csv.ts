import type { NoteMeta } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import { distinctNotes } from "./dbgroup.ts";

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Spreadsheet formula-injection guard (decided 2026-08-04): a cell
    whose text STARTS with `=`, `+`, `-` or `@` is a live formula the moment the
    exported file is opened in Excel/Numbers/LibreOffice, so it ships with the
    standard `'` text-marker prefix. Safe by default, no setting.
    Export-only, deliberately: the in-note sheet writer (`serializeCsv`) and the
    CSV importer are untouched, so nothing in the vault grows apostrophes and an
    in-app roundtrip stays byte-faithful. A formula-looking string that merely
    contains `=` mid-cell is left alone — only the leading character makes a
    spreadsheet evaluate it. Re-importing an exported file keeps the `'` as
    literal text: spreadsheets swallow it, plain parsers (ours included) don't. */
function escapeFormula(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

const csvCell = (v: string) => csvField(escapeFormula(v));

/** The table view as CSV: name column first, then the visible prop columns,
    rows in the order the table currently shows them — one row per NOTE.
    Grouping is view-only: a note that a list-valued
    group puts in several sections is on screen once per membership, but the
    file holds it once, at its first on-screen position, so a grouped export
    is byte-identical to the same view's ungrouped one. Same de-duplication
    the footer tallies over. */
export function buildCsv(columns: string[], rows: NoteMeta[]): string {
  const lines = [["title", ...columns].map(csvCell).join(",")];
  for (const n of distinctNotes(rows)) {
    const cells = [n.title, ...columns.map((c) => foldedPropStr(n.props, c) ?? "")];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
