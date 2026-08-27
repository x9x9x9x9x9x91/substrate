// Heatmap blocks: a ```heatmap fence declares one year of day
// squares — the contribution-graph read of a database or a sheet. Config is
// the same hand-editable key: value text every other fence uses:
//
//   ```heatmap
//   source: session            # a database type, or {{Sheet Name}} for a sheet
//   date: logged               # the date property/column the squares sit on
//   value: count               # count | sum:<number prop>
// query: status:done # the filter-bar language (optional, db only)
//   ```
//
// Nothing else: a heatmap is one question ("how much, per day, across a
// year"), so there is no kind, no title and no axis to configure. The year is
// derived from the data — the latest year that carries a matching date —
// rather than declared, so the fence keeps saying something true as the vault
// moves past it.
//
// The row plumbing is chart.ts's, deliberately: same {{Sheet}}/database source
// grammar, same strict cell numbers, same leading-ISO-date read, same named
// binding error. The query is the query language (filterByQuery), not a second
// dialect of it.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import {
  cellNumber,
  dateOf,
  dbRows,
  missingBinding,
  parseSource,
  scalarCellString,
  type ChartRow,
  type ChartSource,
} from "./chart.ts";
import { daysInMonth, MONTHS, toIso, todayIso } from "./dates.ts";
import { hasUnclosedFence } from "./fences.ts";
import { typeSchemaFor } from "./schemalookup.ts";
import { foldedPropStr } from "./types.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { filterByQuery } from "./views.ts";

/** How a day's square gets its number: how many rows landed there, or the sum
    of one numeric property over them. No avg — an average per day answers a
    different question than an intensity grid asks. */
export type HeatmapValue = { fn: "count" } | { fn: "sum"; prop: string };

export interface HeatmapConfig {
  source: ChartSource;
  /** the date property (database) or column (sheet) each row is stamped with */
  date: string;
  value: HeatmapValue;
  /** the filter-bar query, database sources only; null when absent */
  query: string | null;
}

/** One parsed ```heatmap fence: a config, a human-readable error, or a fence
    that is not filled in yet — the chart-block shape, so a broken fence renders
    in place and never takes its siblings down.

    `needs` is the third state, and it is not an error: the required keys this
    fence has left blank or has not written at all. The slash scaffold inserts
    exactly that fence — `source:` and `date:` with nothing after them — so the
    first thing anyone saw after typing /heatmap was a parse error over their
    own untouched scaffold. A fence still being written gets told what it
    wants; a fence written WRONG (unknown key, duplicate, unreadable line, a
    value no reading fits) still gets the error box. */
export interface HeatmapBlock {
  config: HeatmapConfig | null;
  error: string | null;
  /** required keys still blank, in fence order; null once there are none */
  needs: string[] | null;
}

/** Thrown by `parseHeatmapConfig` for a fence that is merely unfinished, so
    the block scanner can tell it apart from a malformed one without parsing
    an error sentence back. */
export class HeatmapUnfinished extends Error {
  /** the required keys still blank, in fence order */
  readonly needs: string[];

  constructor(needs: string[]) {
    super(heatmapNeedsMessage(needs));
    this.name = "HeatmapUnfinished";
    this.needs = needs;
  }
}

/** What each required key takes, in the fence's own words — the sentence the
    unfinished fence shows in place of a grid. Same voice as the rest of the
    empty states: what is missing, then what would fill it. */
const KEY_WANTS: Record<string, string> = {
  source: "source: a database type, or {{Sheet Name}} for a sheet",
  date: "date: the date property the squares sit on",
  value: "value: count, or sum:<number prop>",
};

export function heatmapNeedsMessage(needs: string[]): string {
  const wants = needs.map((k) => KEY_WANTS[k] ?? `${k}: a value`);
  return `This heatmap is not filled in yet — ${wants.join("; ")}. Fill those in and the year of squares draws itself.`;
}

// ---------- config parsing ----------

const KNOWN_KEYS = new Set(["source", "date", "value", "query"]);

function parseValue(v: string): HeatmapValue {
  if (v.toLowerCase() === "count") return { fn: "count" };
  // a bare "sum:" carries no property, so it falls through to the same named
  // error as "avg:hours" or "total" rather than a second way of saying it
  const m = /^sum:\s*(\S[\s\S]*)$/i.exec(v);
  if (m) return { fn: "sum", prop: m[1].trim() };
  throw new Error(`value must be count or sum:<prop> — got "${v}"`);
}

/** Parse one fence body; throws on any malformed line or unknown key, and
    throws `HeatmapUnfinished` when the fence is merely still blank. The fence
    is hand-written text, so every mistake gets named.

    A key written with no value (`source:`) is the unfinished case, not a
    broken line: it is what the slash scaffold inserts and what half-typed
    config looks like between two keystrokes. The key still has to be one a
    heatmap takes and still may not repeat — a blank `kind:` is as wrong as a
    filled one. */
export function parseHeatmapConfig(inner: string): HeatmapConfig {
  const kv = new Map<string, string>();
  const seen = new Set<string>();
  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/.exec(line);
    if (!m) throw new Error(`can't parse line: ${line}`);
    const key = m[1].toLowerCase();
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`unknown key "${m[1]}" — heatmaps take source, date, value, query`);
    }
    if (seen.has(key)) throw new Error(`duplicate key "${m[1]}"`);
    seen.add(key);
    const value = m[2].trim();
    if (value !== "") kv.set(key, value);
  }
  const needs = ["source", "date", "value"].filter((req) => !kv.has(req));
  if (needs.length > 0) throw new HeatmapUnfinished(needs);
  const source = parseSource(kv.get("source")!);
  const query = kv.get("query") ?? null;
  // `query` is the database filter bar; a sheet has no notes to filter, so a
  // sheet-sourced query is a mistake worth naming rather than silently ignored
  if (query !== null && source.kind !== "db") {
    throw new Error("query filters database notes — drop query, or source a database");
  }
  return { source, date: kv.get("date")!, value: parseValue(kv.get("value")!), query };
}

/** All ```heatmap fences in a note body, in order. Never throws.

    The opener folds case (```HeatMap opens a fence) because the hub's
    renderMarkdown does — it lowercases the lang before dispatching, so a
    mixed-case opener renders the live year grid there. Matching the literal
    lowercase spelling here made the SAME note render a grid on the hub and
    nothing in the dashboard pane, and the strip pass already
    follows the wider spelling (CASE_FOLDING_BARE_LANGS in fences.ts), so a
    mixed-case fence's config is out of the search index either way. Still
    bare-form: only horizontal whitespace may follow the lang, so a tailed
    opener — prose for every bare-form language — is still refused. That
    whitespace is allowed because a stray space is a typo, not a second word:
    ```heatmap␠ used to match nothing at all and draw a blank board with no
    sentence about why. */
export function parseHeatmapBlocks(body: string): HeatmapBlock[] {
  const re = /```heatmap[ \t]*\r?\n([\s\S]*?)```/gi;
  const out: HeatmapBlock[] = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    try {
      out.push({ config: parseHeatmapConfig(m[1]), error: null, needs: null });
    } catch (e) {
      if (e instanceof HeatmapUnfinished) out.push({ config: null, error: null, needs: e.needs });
      else out.push({ config: null, error: e instanceof Error ? e.message : String(e), needs: null });
    }
  }
  // an opener with no closing line matched nothing above, so the board would
  // have counted zero and said nothing; the fence gets a banner instead
  if (hasUnclosedFence(body, "heatmap", true))
    out.push({ config: null, needs: null, error: "This ```heatmap fence is never closed — add a closing ``` line so the heatmap can be read." });

  return out;
}

// ---------- aggregation ----------

/** Per-day totals over the whole span the rows cover, before any year is
    chosen — the grid slices this. */
export interface HeatmapTally {
  /** ISO day → total and the row count behind it */
  days: Map<string, { value: number; n: number }>;
  /** rows dropped: no readable date, or a non-numeric `sum:` cell */
  skipped: number;
  /** named error when a bound property exists nowhere in the source */
  missing: string | null;
}

/** Total the rows per ISO day. Prop lookup is case-insensitive (row keys are
    normalized here), dates are the leading ISO day of the cell (so a
    "2026-07-17 10:28" timestamp lands on its day), and `sum:` cells parse
    strictly — "1e3" and "Infinity" are text, and their rows are skipped
    rather than charted as 1000 or an intensity-breaking Infinity. */
export function tallyHeatmap(rows: ChartRow[], config: HeatmapConfig): HeatmapTally {
  const dateKey = config.date.toLowerCase();
  const valueKey = config.value.fn === "count" ? null : config.value.prop.toLowerCase();
  const bound = [config.date, ...(config.value.fn === "sum" ? [config.value.prop] : [])];
  const missing = missingBinding(rows, config.source, bound);
  const days = new Map<string, { value: number; n: number }>();
  let skipped = 0;
  for (const raw of rows) {
    const row: ChartRow = {};
    for (const [k, v] of Object.entries(raw)) row[k.toLowerCase()] = v;
    const cell = scalarCellString(row[dateKey]);
    const iso = cell !== undefined ? dateOf(cell) : null;
    if (!iso) {
      skipped++;
      continue;
    }
    let v = 1;
    if (valueKey !== null) {
      const n = cellNumber(row[valueKey]);
      if (n === null) {
        skipped++;
        continue;
      }
      v = n;
    }
    const d = days.get(iso);
    if (d) {
      d.value += v;
      d.n += 1;
    } else {
      days.set(iso, { value: v, n: 1 });
    }
  }
  return { days, skipped, missing };
}

/** Years the tally touches, ascending. */
export function heatmapYears(tally: HeatmapTally): number[] {
  const years = new Set<number>();
  for (const iso of tally.days.keys()) years.add(Number(iso.slice(0, 4)));
  return [...years].sort((a, b) => a - b);
}

/** The year a fence shows: the latest one carrying data, else the current
    year — so an empty source still draws this year's empty grid instead of
    nothing at all. */
export function pickHeatmapYear(tally: HeatmapTally, today: string = todayIso()): number {
  const years = heatmapYears(tally);
  return years.length > 0 ? years[years.length - 1] : Number(today.slice(0, 4));
}

/** One day square. `n` is the rows behind it, so a zero-summing day still says
    how many rows it holds. */
export interface HeatmapDay {
  iso: string;
  value: number;
  n: number;
  /** 0 (nothing) … 4 (the year's heaviest quarter) */
  level: number;
}

/** A year of squares, laid out the way the grid draws: Monday-first columns of
    seven, `null` where a column runs outside the year. */
export interface HeatmapYearGrid {
  year: number;
  weeks: (HeatmapDay | null)[][];
  /** month name + the column it starts in, for the strip above the grid */
  months: { col: number; label: string }[];
  /** summed over the year (all 365/366 days, not just the active ones) */
  total: number;
  max: number;
  /** days with at least one row */
  active: number;
  skipped: number;
  missing: string | null;
}

/** Levels quarter the year's heaviest day, the way a contribution graph does.
    A day at or below zero is level 0 — an empty square — even when rows landed
    on it: a sum of nothing is nothing, and the tooltip still reports the rows. */
export function heatmapLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

const DAYS_PER_WEEK = 7;

/** Weekday index of an ISO day, Monday = 0 … Sunday = 6 — the week start every
    other grid in the app uses (monthGrid, the chart's week bucket). */
function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** Slice one year out of a tally into the grid the component renders. Every
    day of the year gets a square (absent days are value 0), so hover, tooltips
    and keyboard walking work across the whole year and not only where data
    happens to be. */
export function heatmapGrid(tally: HeatmapTally, year: number): HeatmapYearGrid {
  const cells: HeatmapDay[] = [];
  let total = 0;
  let max = 0;
  let active = 0;
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(year, m); d++) {
      const iso = toIso(year, m, d);
      const hit = tally.days.get(iso);
      const value = hit?.value ?? 0;
      total += value;
      if (value > max) max = value;
      if (hit) active++;
      cells.push({ iso, value, n: hit?.n ?? 0, level: 0 });
    }
  }
  for (const c of cells) c.level = heatmapLevel(c.value, max);

  const lead = weekdayIndex(cells[0].iso);
  const weeks: (HeatmapDay | null)[][] = [];
  let col: (HeatmapDay | null)[] = new Array(lead).fill(null);
  for (const c of cells) {
    col.push(c);
    if (col.length === DAYS_PER_WEEK) {
      weeks.push(col);
      col = [];
    }
  }
  if (col.length > 0) {
    while (col.length < DAYS_PER_WEEK) col.push(null);
    weeks.push(col);
  }

  // a month is labelled above the column its 1st falls in; two months never
  // share a column, so the strip needs no collision rule
  const months = MONTHS.map((label, i) => {
    const first = toIso(year, i + 1, 1);
    const col = Math.floor((lead + cells.findIndex((c) => c.iso === first)) / DAYS_PER_WEEK);
    return { col, label };
  });

  return { year, weeks, months, total, max, active, skipped: tally.skipped, missing: tally.missing };
}

// ---------- row sources ----------

/** Notes of the heatmap's database type, filtered by its `query:`, as rows.
    The filter is `filterByQuery` — the same parse and the same matching the
    filter bar and the ```view fence use, resolved against the type's schema so
    select options and date comparisons behave identically here. */
export function heatmapDbRows(
  config: HeatmapConfig,
  notes: NoteMeta[],
  schema: SchemaConfig,
  today: string = todayIso(),
): ChartRow[] {
  if (config.source.kind !== "db") return [];
  const type = config.source.type;
  const folded = type.toLowerCase();
  const ofType = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === folded);
  const q = config.query?.trim();
  const matched = q ? filterByQuery(ofType, q, today, typeSchemaFor(schema, type) ?? {}) : ofType;
  return dbRows(matched, type);
}

// ---------- display ----------

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The derived title — a heatmap declares no title of its own. */
export function heatmapTitle(c: HeatmapConfig): string {
  const src = c.source.kind === "db" ? c.source.type : c.source.name;
  return c.value.fn === "count" ? `${cap(src)} per day` : `Sum of ${c.value.prop} per day`;
}

/** Provenance line for the heatmap foot. Names the source and nothing else —
    a query is a second fact and gets its own line in the foot, the way
    design-principles §1.6 asks and §6 names the chain a bug. */
export function heatmapSourceDesc(c: HeatmapConfig): string {
  return c.source.kind === "db" ? `database: ${c.source.type}` : `sheet: ${c.source.name}`;
}
