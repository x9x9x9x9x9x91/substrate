// Food database for the `dashboard: food` renderer: the pane's
// second data note — stable kcal/protein bases per food, so autocomplete
// stops replaying the newest logged row (the "presets" complaint
// about). Rows live in the DB sheet's csv fence, header `name,kcal,per,
// protein` where `per` is the basis the numbers are quoted at:
//
//   100g  → kcal/protein per 100 g
//   100ml → kcal/protein per 100 ml
//   x     → per unit/piece ("Eggs,80,x" = 80 kcal the egg)
//
// protein is optional. So is `g`: grams per one unit on x rows
// ("Eggs,80,x,7,55" = a 55 g egg), which lets autocomplete price gram-typed
// quantities against piece-based foods. Header lookup is name-based and
// order-free like the food log (food.ts); the sheet stays hand-editable,
// malformed rows are skipped rather than errors.
//
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { replaceCsvRows } from "./sheet.ts";
import { headerIndex, readNoteTable } from "./notetable.ts";
import { parseStrictNumber } from "./aggregate.ts";

export type DbBasis = "100g" | "100ml" | "x";

export interface FoodDbEntry {
  name: string;
  /** kcal per one `per` basis */
  kcal: number;
  per: DbBasis;
  /** g protein per one `per` basis; null when empty/column missing */
  protein: number | null;
  /** grams per ONE UNIT (per=x only — the piece↔gram bridge);
      null when empty/column missing. Ignored on 100g/100ml rows. */
  g: number | null;
  /** data-row index in the csv fence (header excluded) — the delete handle */
  idx: number;
}

// canonical cell value is "x"; "unit" is accepted on read for hand editors
const PER_WORDS: Record<string, DbBasis | undefined> = {
  "100g": "100g",
  "100ml": "100ml",
  x: "x",
  unit: "x",
};

/** All well-formed rows of the DB sheet's csv fence, sheet order. Rows with
    an empty name, non-numeric kcal, or an unknown `per` word are skipped,
    not errors. */
export function parseFoodDb(body: string): FoodDbEntry[] {
  const table = readNoteTable(body);
  if (!table) return [];
  const ni = table.col("name");
  const ki = table.col("kcal");
  const bi = table.col("per");
  const pi = table.col("protein");
  // grams-per-unit column: canonical header "g", "g_per_unit"
  // accepted for hand editors
  const gi = table.col("g", "g_per_unit");
  if (ni < 0 || ki < 0 || bi < 0) return [];
  const out: FoodDbEntry[] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const cells = table.rows[r];
    const name = table.text(cells, ni);
    // strict parse like sheet cells: "1e3"/"Infinity" stay text
    const kcal = parseStrictNumber(table.raw(cells, ki));
    const per = PER_WORDS[table.text(cells, bi).toLowerCase()];
    if (name === "" || kcal === null || per === undefined) continue;
    const protein = pi >= 0 ? parseStrictNumber(table.raw(cells, pi)) : null;
    const g = gi >= 0 ? parseStrictNumber(table.raw(cells, gi)) : null;
    out.push({ name, kcal, per, protein, g, idx: r });
  }
  return out;
}

export interface FoodDbInput {
  name: string;
  kcal: number;
  per: DbBasis;
  protein: number | null;
  /** grams per one unit (per=x only); null = unknown */
  g: number | null;
}

const CSV_HEADER = ["name", "kcal", "per", "protein"];

/** Body with the entry upserted into the csv fence (created, header included,
    when the note has none yet): a same-name row (case-insensitive) is
    replaced in place — the DB is keyed by name, silent dupes are drift.
    Cells map into the EXISTING header like the food log's append, and a
    missing protein column is added when the entry carries one. */
export function upsertFoodDbEntry(body: string, e: FoodDbInput): string {
  const table = readNoteTable(body);
  const parsed = table ? table.allRows() : [];
  // blank lines parse as [""] rows; drop them like appendFoodEntry does
  const rows = parsed.filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) rows.push([...CSV_HEADER]);
  const headers = rows[0];
  if (e.protein !== null && headerIndex(headers, "protein") < 0) headers.push("protein");
  // the grams-per-unit column is written as "g"; a hand-made
  // "g_per_unit" header is filled rather than duplicated
  if (e.g !== null && headerIndex(headers, "g", "g_per_unit") < 0) headers.push("g");
  const cells = headers.map((h) => {
    switch (h.trim().toLowerCase()) {
      case "name":
        return e.name;
      case "kcal":
        return String(e.kcal);
      case "per":
        return e.per;
      case "protein":
        return e.protein === null ? "" : String(e.protein);
      case "g":
      case "g_per_unit":
        return e.g === null ? "" : String(e.g);
      default:
        return ""; // a column this pane doesn't know stays empty
    }
  });
  const ni = headerIndex(headers, "name");
  const at =
    ni < 0
      ? -1
      : rows.findIndex(
          (r, i) => i > 0 && (r[ni] ?? "").trim().toLowerCase() === e.name.toLowerCase()
        );
  if (at >= 0) rows[at] = cells;
  else rows.push(cells);
  return replaceCsvRows(body, rows);
}

/** Body with data row `idx` (header excluded) removed; unchanged when the
    index is stale — the vault may have moved under the pane. */
export function removeFoodDbEntry(body: string, idx: number): string {
  const table = readNoteTable(body);
  if (!table) return body;
  if (idx < 0 || idx >= table.rows.length) return body;
  table.rows.splice(idx, 1);
  return replaceCsvRows(body, table.allRows());
}
