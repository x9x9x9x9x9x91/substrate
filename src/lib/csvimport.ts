import { normalizeNumberInput } from "./aggregate.ts";
import { parseDateTimeLoose } from "./dates.ts";
import { basename } from "./files.ts";

/* CSV import: the pure mapping from parsed CSV rows (parseCsv,
   src/lib/sheet.ts) to notes-to-create. The dialog (CsvImportDialog,
   DbAdmin.tsx) owns the choices; these functions own the consequences.
   Picking/reading the file lives in csvpick.ts — it touches Tauri IPC,
   which can't load under node --test. */

/** Imports over this many rows get a "large import" warning in the dialog. */
export const CSV_IMPORT_LARGE = 500;

/** The kinds a column may be imported as. A flat CSV cell is one string
    and `vault_create` writes props as strings, so this is exactly the set
    whose stored form IS a string.

    `select` is the one that needs more than the cell: a select IS its
    options, and an optionless one is not a column any editor would show as
    select. An import is the one create that can supply them — the column's
    own distinct values are the vocabulary (csvSelectOptions), so a
    select-imported column arrives as a finished select rather than as text
    waiting for a schema pass.

    The kinds NOT here:

      checkbox needs the YAML bool `true` (a cell reading "true" is a string
        and paints unchecked), and multi needs a YAML list — one string is one
        chip, so "a, b" would import as a single value named "a, b". Both
        would need a second write per cell to be honest, so neither is offered.
      relation needs a target database, and its values have to resolve to
        entries that exist; rollup is derived and stores nothing at all.
      file names a path in the vault — a spreadsheet column of them is not
        what the picker means, and a wrong one reads as a broken link.

    Everything else parses from the cell text alone (csvCellValue). */
export const CSV_KINDS = ["text", "select", "number", "date", "url", "email", "phone"] as const;

export type CsvKind = (typeof CSV_KINDS)[number];

/** One CSV column as shown in the import dialog. `kind` is what the
    column becomes in the new database's schema — absent reads as text, which
    is what every column was before the choice existed. */
export interface CsvColumn {
  name: string;
  include: boolean;
  kind?: CsvKind;
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
    `icon`, `home` and `parent` are database keys — `create_type` rejects them
    outright, which kills the whole import. */
const CSV_RESERVED = ["created", "type", "title", "icon", "home", "parent"];

/** Column names as the database will really store them.
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

/** One cell as the column's kind stores it. A spreadsheet writes dates and
    numbers in whatever dialect its author used, and importing that verbatim
    gives a date column no calendar can read and a number column that drops
    out of every sum. Both are put through the SAME normalizers a typed cell
    goes through — the date menu's commit shape (`YYYY-MM-DD`, plus ` HH:MM`
    when the cell carries a time) and the number commit boundary's canonical
    dot-decimal. Text that parses as neither is stored exactly as written:
    junk passing through as typed is what every cell editor here already
    does, and an import that quietly dropped it would lose the only copy. */
export function csvCellValue(raw: string, kind: CsvKind | undefined): string {
  const v = raw.trim();
  if (!v) return v;
  if (kind === "date") {
    const dt = parseDateTimeLoose(v);
    if (!dt) return v;
    return dt.time ? `${dt.day} ${dt.time}` : dt.day;
  }
  if (kind === "number") return normalizeNumberInput(v);
  return v;
}

/** A select column's vocabulary: the distinct values the import is about to
    write for `name`, in the order the schema editor would have listed them.

    This is deliberately the SAME derivation App's `usedValues` runs to fill
    the schema editor's option list — read the values in use, drop blanks,
    keep distinct spellings, then sort with the app's own comparator (numeric,
    case-insensitive). Feeding it the entries rather than the notes is the
    same set one step earlier: those entries ARE the notes about to exist. So
    an import-created select is the entry the one-editor-save flow would have
    produced, without the pass where the column is still text.

    Values differing only in case survive here and collapse on write, exactly
    as the editor's save collapses them (the engine's option normalization
    keeps the first spelling). No cap: neither path has one, and a column's
    vocabulary is as long as its author made it. */
export function csvSelectOptions(entries: CsvEntry[], name: string): string[] {
  const seen = new Set<string>();
  for (const e of entries) {
    for (const [key, value] of e.props) {
      if (key === name && value) seen.add(value);
    }
  }
  return [...seen].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/** The first cell a column actually has something in, for the dialog's
    preview — "" when the column is empty. Reads the same data rows the
    import will, so the sample is a row that is really being imported. */
export function csvSampleCell(
  rows: string[][],
  firstRowHeaders: boolean,
  index: number,
): string {
  const data = firstRowHeaders ? rows.slice(1) : rows;
  for (const row of data) {
    const cell = (row[index] ?? "").trim();
    if (cell) return cell;
  }
  return "";
}

/** CSV rows → entries given the column choices. The first included column
    becomes the title, the other included columns become [name, value] props,
    each value stored the way its column's kind stores it. Cells (and titles)
    are trimmed; a row whose included cells are all blank is skipped. */
export function csvEntries(
  rows: string[][],
  firstRowHeaders: boolean,
  columns: CsvColumn[],
): CsvEntry[] {
  const included = columns
    .map((c, i) => ({ name: c.name, i, include: c.include, kind: c.kind }))
    .filter((c) => c.include);
  if (included.length === 0) return [];
  const [titleCol, ...propCols] = included;
  const data = firstRowHeaders ? rows.slice(1) : rows;
  const cell = (row: string[], i: number) => (row[i] ?? "").trim();
  const out: CsvEntry[] = [];
  for (const row of data) {
    if (included.every((c) => cell(row, c.i) === "")) continue;
    out.push({
      // the title column's kind never applies: it becomes the note's
      // title, which is prose in every database
      title: cell(row, titleCol.i),
      props: propCols.map(
        (c) => [c.name, csvCellValue(cell(row, c.i), c.kind)] as [string, string],
      ),
    });
  }
  return out;
}

/** "Gero QA.csv" → "Gero QA" — the database-name prefill from a picked file. */
export function dbNameFromFile(fileName: string): string {
  return basename(fileName).replace(/\.[^.]+$/, "").trim() || "Imported";
}
