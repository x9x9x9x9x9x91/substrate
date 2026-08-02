import type { NoteMeta } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import { distinctNotes } from "./dbgroup.ts";

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The table view as CSV: name column first, then the visible prop columns,
    rows in the order the table currently shows them — one row per NOTE.
    Grouping is view-only (SUB-563): a note that a list-valued
    group puts in several sections is on screen once per membership, but the
    file holds it once, at its first on-screen position, so a grouped export
    is byte-identical to the same view's ungrouped one. Same de-duplication
    the footer tallies over (SUB-561). */
export function buildCsv(columns: string[], rows: NoteMeta[]): string {
  const lines = [["title", ...columns].map(csvField).join(",")];
  for (const n of distinctNotes(rows)) {
    const cells = [n.title, ...columns.map((c) => foldedPropStr(n.props, c) ?? "")];
    lines.push(cells.map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}
