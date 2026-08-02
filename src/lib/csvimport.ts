import { basename } from "./files.ts";

/* CSV import (SUB-274): the pure mapping from parsed CSV rows (parseCsv,
   src/lib/sheet.ts) to notes-to-create. The dialog (CsvImportDialog,
   DbAdmin.tsx) owns the choices; these functions own the consequences.
   Picking/reading the file lives in csvpick.ts — it touches Tauri IPC,
   which can't load under node --test. */

/** Imports over this many rows get a "large import" warning in the dialog. */
export const CSV_IMPORT_LARGE = 500;

/** One CSV column as shown in the import dialog. */
export interface CsvColumn {
  name: string;
  include: boolean;
}

/** One CSV row as a note-to-create: `title` from the first included column,
    `props` from the rest, in column order. */
export interface CsvEntry {
  title: string;
  props: [string, string][];
}

/** Column names for the picker: the trimmed header row when the first row is
    headers, else positional names. The width covers the widest row so ragged
    rows never lose cells silently; a blank header cell falls back to the
    positional name rather than dropping the column's data. */
export function csvColumns(rows: string[][], firstRowHeaders: boolean): CsvColumn[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const out: CsvColumn[] = [];
  for (let i = 0; i < width; i++) {
    const header = firstRowHeaders ? (rows[0]?.[i] ?? "").trim() : "";
    out.push({ name: header || `Column ${i + 1}`, include: true });
  }
  return out;
}

/** Property names Substrate already owns. `created`, `type` and `title` are
    the note's own frontmatter fields — `create_full` skips them, so a column
    with one of those names imports as empty while the toast says success.
    `icon` and `home` are database keys — `create_type` rejects them outright,
    which kills the whole import. */
const CSV_RESERVED = ["created", "type", "title", "icon", "home"];

/** Column names as the database will really store them (SUB-559, SUB-562).
    A spreadsheet export routinely carries a name Substrate owns, or the same
    name twice — and both used to be discovered too late: the reserved one
    imported as an empty column, and the duplicate aborted the import on
    submit, after the user had named the database and picked their columns.
    Suffix instead of refusing, and do it here so the dialog shows the real
    destination name before anything is written.

    The title column is exempt: it becomes the note's title, not a property,
    so a CSV whose first column is called `title` — the common case — keeps
    its name. Excluded columns are left alone; they never become properties. */
export function csvSafeColumns(columns: CsvColumn[]): CsvColumn[] {
  const titleIdx = columns.findIndex((c) => c.include);
  const taken = new Set<string>();
  return columns.map((c, i) => {
    if (i === titleIdx || !c.include) return c;
    let name = c.name;
    const clash = () => CSV_RESERVED.includes(name.toLowerCase()) || taken.has(name.toLowerCase());
    for (let n = 2; clash(); n++) name = `${c.name} ${n}`;
    taken.add(name.toLowerCase());
    return { ...c, name };
  });
}

/** CSV rows → entries given the column choices. The first included column
    becomes the title, the other included columns become [name, value] props.
    Cells (and titles) are trimmed; a row whose included cells are all blank
    is skipped. */
export function csvEntries(
  rows: string[][],
  firstRowHeaders: boolean,
  columns: CsvColumn[],
): CsvEntry[] {
  const included = columns
    .map((c, i) => ({ name: c.name, i, include: c.include }))
    .filter((c) => c.include);
  if (included.length === 0) return [];
  const [titleCol, ...propCols] = included;
  const data = firstRowHeaders ? rows.slice(1) : rows;
  const cell = (row: string[], i: number) => (row[i] ?? "").trim();
  const out: CsvEntry[] = [];
  for (const row of data) {
    if (included.every((c) => cell(row, c.i) === "")) continue;
    out.push({
      title: cell(row, titleCol.i),
      props: propCols.map((c) => [c.name, cell(row, c.i)] as [string, string]),
    });
  }
  return out;
}

/** "Gero QA.csv" → "Gero QA" — the database-name prefill from a picked file. */
export function dbNameFromFile(fileName: string): string {
  return basename(fileName).replace(/\.[^.]+$/, "").trim() || "Imported";
}
