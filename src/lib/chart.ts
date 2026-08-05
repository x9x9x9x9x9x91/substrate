// Chart blocks: a ```chart fence inside a dashboard note declares one chart.
// Config stays hand-editable key: value text (portable), e.g.
//
//   ```chart
//   source: release            # a database type, or {{Sheet Name}} for a sheet
//   x: released:month          # date prop bucketed day|week|month, or a select prop
//   y: count                   # count | sum:<number prop> | avg:<number prop>
//   kind: bar                  # bar | line (default bar)
//   title: Releases per month  # optional
//   ```
//
// A sheet's named summaries plot too (SUB-745), one point per summary, instead
// of x/y over rows — so a per-bucket COUNTIF/SUMIF set charts without
// materializing bucket rows in the sheet:
//
//   ```chart
//   source: {{Holdings}}
//   series: etf, crypto, cash  # named summaries on that sheet
//   ```
//
// An optional `by: <prop|column>` splits the y measure into one series per
// distinct value of that field (SUB-941) — stacked bars, multi-line:
//
//   ```chart
//   source: expense
//   x: spent:month
//   y: sum:amount
//   by: category        # one series per category
//   ```
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { parseStrictNumber } from "./aggregate.ts";
import { isIsoDate, MONTHS, toIso } from "./dates.ts";
import { isErr } from "./formula.ts";
import { propSchemaFor } from "./schemalookup.ts";
import type { SheetEval, SheetModel } from "./sheet.ts";
import type { NoteMeta, SchemaConfig, SelectOption } from "./types.ts";
import { foldedPropStr } from "./types.ts";

export type ChartBucket = "day" | "week" | "month";
export type ChartKind = "bar" | "line";

export type ChartSource = { kind: "db"; type: string } | { kind: "sheet"; name: string };

export type ChartAgg = { fn: "count" } | { fn: "sum" | "avg"; prop: string };

export interface ChartAxis {
  prop: string;
  bucket: ChartBucket | null; // null = categorical axis (select prop / text column)
}

/** How a chart gets its points. `rows` is the original binding: bucket the
    source's rows by `x`, reduce with `y`. `summaries` (SUB-745) names sheet
    summaries instead — one point per named summary, no rows involved — so a
    per-bucket COUNTIF/SUMIF set charts without materializing bucket rows. */
export type ChartBind =
  | { bind: "rows"; x: ChartAxis; y: ChartAgg; by: string | null }
  | { bind: "summaries"; series: string[] };

export type ChartConfig = {
  source: ChartSource;
  kind: ChartKind;
  title: string | null;
} & ChartBind;

/** A chart config known to use the row binding (has `x`/`y`). */
export type RowChartConfig = ChartConfig & { bind: "rows" };

/** One parsed ```chart fence: either a valid config or a human-readable error. */
export interface ChartBlock {
  config: ChartConfig | null;
  error: string | null;
}

export interface ChartPoint {
  key: string; // sortable bucket key (iso date, yyyy-mm, or the category itself)
  label: string; // short axis label
  value: number;
  n: number; // rows that landed in this bucket
}

export interface ChartSeries {
  points: ChartPoint[];
  skipped: number; // rows dropped: missing/unparseable x, or non-numeric y
  /** Named error when a bound x/y/by property exists nowhere in the source —
      "no column “value_usd” on Holdings (has: …)". Null when every bound
      property is real, so genuine zero-match plots keep the neutral empty
      state instead of accusing a column that is there. */
  missing: string | null;
  /** The `by:` split (SUB-941), null for a single-measure chart. Bands share
      the x axis: every band lists the SAME keys in the same order, so a bar
      stacks and a line reads point-for-point against its neighbours. */
  bands: ChartBand[] | null;
}

/** One series of a `by:`-split chart — the distinct value plus its points. */
export interface ChartBand {
  name: string; // the distinct `by` value, in its first-seen casing
  points: ChartPoint[];
}

// ---------- config parsing ----------

const KNOWN_KEYS = new Set(["source", "x", "y", "kind", "title", "series", "by"]);
const BUCKETS = new Set(["day", "week", "month"]);

/** The shared fence source grammar: a bare word is a database type, `{{Name}}`
    is a sheet. Exported because every fence that reads rows (```chart,
    ```heatmap, ```progress) must accept exactly the same spelling. */
export function parseSource(v: string): ChartSource {
  const m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(v);
  if (m) return { kind: "sheet", name: m[1] };
  if (!v) throw new Error("source must be a database or {{Sheet Name}}");
  return { kind: "db", type: v };
}

function parseAxis(v: string): ChartAxis {
  const m = /^(.+?):([A-Za-z]+)$/.exec(v);
  if (m) {
    const b = m[2].toLowerCase();
    if (!BUCKETS.has(b)) throw new Error(`unknown x bucket "${m[2]}" — want day, week or month`);
    return { prop: m[1].trim(), bucket: b as ChartBucket };
  }
  if (!v) throw new Error("x must name a property");
  return { prop: v, bucket: null };
}

function parseAgg(v: string): ChartAgg {
  if (v.toLowerCase() === "count") return { fn: "count" };
  const m = /^(sum|avg):([\s\S]+)$/i.exec(v);
  if (m) return { fn: m[1].toLowerCase() as "sum" | "avg", prop: m[2].trim() };
  throw new Error(`y must be count, sum:<prop> or avg:<prop> — got "${v}"`);
}

/** Parse one fence body; throws on any malformed line or missing key. */
export function parseChartConfig(inner: string): ChartConfig {
  const kv = new Map<string, string>();
  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(line);
    if (!m) throw new Error(`can't parse line: ${line}`);
    const key = m[1].toLowerCase();
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown key "${m[1]}"`);
    kv.set(key, m[2].trim());
  }
  if (!kv.has("source")) throw new Error(`missing required key "source"`);
  const kindRaw = (kv.get("kind") ?? "bar").toLowerCase();
  if (kindRaw !== "bar" && kindRaw !== "line") {
    throw new Error(`kind must be bar or line — got "${kv.get("kind")}"`);
  }
  const source = parseSource(kv.get("source")!);
  const head = { source, kind: kindRaw as ChartKind, title: kv.get("title") ?? null };

  // `series` is the summary binding; it replaces x/y rather than joining them,
  // so a fence that carries both is a mistake worth naming rather than one of
  // the two silently winning.
  if (kv.has("series")) {
    if (kv.has("x") || kv.has("y")) {
      throw new Error("series charts plot summaries — drop x and y, or drop series");
    }
    // `by` splits a row measure into series; `series` already IS the series
    // list. Both together name the same axis twice, so say which one to drop
    // rather than letting one quietly win (SUB-941).
    if (kv.has("by")) {
      throw new Error("by splits a row measure — drop by, or drop series");
    }
    if (source.kind !== "sheet") {
      throw new Error("series names sheet summaries — source must be {{Sheet Name}}");
    }
    const series = kv
      .get("series")!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (series.length === 0) throw new Error("series must name at least one summary");
    return { ...head, bind: "summaries", series };
  }

  for (const req of ["x", "y"]) {
    if (!kv.has(req)) throw new Error(`missing required key "${req}"`);
  }
  // a valueless `by:` never reaches here — the line parser rejects it like any
  // other empty key, which is the message the author already knows
  const y = parseAgg(kv.get("y")!);
  const by = kv.get("by")?.trim() || null;
  if (by && head.kind === "bar" && y.fn === "avg") {
    throw new Error("by + avg cannot be stacked — use kind: line, sum or count");
  }
  return {
    ...head,
    bind: "rows",
    x: parseAxis(kv.get("x")!),
    y,
    by,
  };
}

/** All ```chart fences in a note body, in order. Never throws. */
export function parseChartBlocks(body: string): ChartBlock[] {
  const re = /```chart\r?\n([\s\S]*?)```/g;
  const out: ChartBlock[] = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    try {
      out.push({ config: parseChartConfig(m[1]), error: null });
    } catch (e) {
      out.push({ config: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// ---------- date bucketing ----------

/** Bucket key for an ISO date. Day = the date itself, month = yyyy-mm,
    week = the Monday of the containing week (Monday-first, like the pickers). */
export function bucketKey(iso: string, bucket: ChartBucket): string {
  if (bucket === "day") return iso;
  if (bucket === "month") return iso.slice(0, 7);
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7; // Mon=0 … Sun=6
  dt.setDate(dt.getDate() - dow);
  return toIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/** Short axis label for a bucket key: "Jul 17" (day/week) or "Jul 2026" (month). */
export function bucketLabel(key: string, bucket: ChartBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  if (bucket === "month") return `${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1]} ${d}`;
}

/** The bucket key that follows `key` on the time axis. */
function nextBucketKey(key: string, bucket: ChartBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  if (bucket === "month") return toIso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1).slice(0, 7);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + (bucket === "week" ? 7 : 1));
  return toIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// If zero-filling would produce more points than this, one stray date is
// dominating the axis — keep the gap rather than render hundreds of empty bars.
const MAX_FILLED_POINTS = 200;

/** Insert value-0 points for empty buckets between the first and last point,
    so bar time axes don't silently skip periods (May|Jun|Aug reading as
    adjacent). Expects `points` sorted ascending by key. */
function zeroFilled(points: ChartPoint[], bucket: ChartBucket): ChartPoint[] {
  if (points.length < 2) return points;
  const out: ChartPoint[] = [points[0]];
  for (const p of points.slice(1)) {
    for (let k = nextBucketKey(out[out.length - 1].key, bucket); k < p.key; k = nextBucketKey(k, bucket)) {
      out.push({ key: k, label: bucketLabel(k, bucket), value: 0, n: 0 });
      if (out.length > MAX_FILLED_POINTS) return points;
    }
    out.push(p);
  }
  return out;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/** Leading ISO date of a raw cell/prop value ("2026-07-17", "2026-07-17 10:28"). */
export function dateOf(raw: string): string | null {
  const m = DATE_PREFIX.exec(raw.trim());
  return m && isIsoDate(m[1]) ? m[1] : null;
}

// ---------- aggregation ----------

/** One input row for aggregation; keys are lowercased prop/column names. */
export type ChartRow = Record<string, unknown>;

/** One scalar cell as an x label. An FErr or any structured value has no
    honest scalar form; date axes deliberately stay on this narrower path. */
export function scalarCellString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Categorical axes additionally label all-string lists with the same
    comma-space semantics as `propStr`. Mixed/object lists still skip rather
    than collapsing into "[object Object]" (SUB-671). */
function categoricalCellString(v: unknown): string | undefined {
  const scalar = scalarCellString(v);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(v) && v.every((item) => typeof item === "string")) return v.join(", ");
  return undefined;
}

/** One cell as a y value. Strings parse strictly (SUB-675, the same
    `parseStrictNumber` the footer/formula/sheet/sort surfaces use), so "1e3",
    "0x10" and "Infinity" stay text and count as skipped rows rather than
    charting as 1000, 16 or an axis-breaking Infinity point. */
export function cellNumber(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string") return parseStrictNumber(v);
  return null;
}

/** What a source calls its fields, for honest binding errors: a sheet has
    columns, a database has properties. */
function fieldNoun(source: ChartSource, n: number): string {
  if (n === 1) return source.kind === "sheet" ? "column" : "property";
  return source.kind === "sheet" ? "columns" : "properties";
}

/** The name a binding error points at ("Holdings", "release"). */
function sourceLabel(source: ChartSource): string {
  return source.kind === "sheet" ? source.name : source.type;
}

/** Named error when a bound x/y property is absent from every row of the
    source — the chart's own "no column “value_usd” on Holdings" instead of the
    generic empty state, matching the engine's convention that a miss reports by
    name (a LOOKUP miss, a `series:` binding to a non-summary).

    Absence is structural, not a skip count: the universe is the union of the
    rows' own keys, so a column that exists but whose cells all fail (filters,
    errors, non-numeric text) still reads as a genuine zero-match. With no rows
    at all there is no universe to judge against, so nothing is claimed.

    Takes the bound names rather than a chart config so every row-reading fence
    speaks with one voice — the ```heatmap fence binds `date:`/`sum:` and gets
    the identical sentence. */
export function missingBinding(
  rows: ChartRow[],
  source: ChartSource,
  bound: string[],
): string | null {
  if (rows.length === 0) return null;
  // first-seen order, as authored — the fence author reads back their own
  // headers, so the list keeps the source's casing rather than the folded keys
  const present = new Map<string, string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) if (!present.has(k.toLowerCase())) present.set(k.toLowerCase(), k);
  }
  const gone = bound.filter((p) => !present.has(p.toLowerCase()));
  if (gone.length === 0) return null;
  const noun = fieldNoun(source, gone.length);
  const names = gone.map((p) => `“${p}”`).join(" or ");
  const has = [...present.values()].join(", ");
  return `no ${noun} ${names} on ${sourceLabel(source)} (has: ${has})`;
}

/** One reduced cell: the running sum and the rows behind it. */
interface Cell {
  sum: number;
  n: number;
}

function reduce(cell: Cell, fn: ChartAgg["fn"]): number {
  return fn === "avg" ? cell.sum / cell.n : fn === "sum" ? cell.sum : cell.n;
}

/** Bucket rows by the x axis and reduce them per the y aggregation. Date axes
    sort ascending by key; categorical axes follow the schema option order when
    `xOptions` is given (unschematized values keep first-appearance order after),
    else plain first-appearance order. Prop lookup is case-insensitive (row keys
    are normalized here).

    With `by` (SUB-941) the same rows additionally pivot into one band per
    distinct value of that field, first-seen order — the axis is unchanged, so
    `points` stays the whole-chart series (the foot's count, the empty state)
    and `bands` carries the split. Bands walk the SAME ordered x keys as
    `points`: bars carry every key (absent = a 0-height slice, so stacks line
    up), lines carry only the keys where that band has rows (a drawn zero would
    read as data — the single-series line rule, per band). */
export function aggregate(
  rows: ChartRow[],
  config: RowChartConfig,
  xOptions?: SelectOption[],
): ChartSeries {
  const xKey = config.x.prop.toLowerCase();
  const yKey = config.y.fn === "count" ? null : config.y.prop.toLowerCase();
  const byKey = config.by?.toLowerCase() ?? null;
  const missing = missingBinding(rows, config.source, [
    config.x.prop,
    ...(config.y.fn !== "count" ? [config.y.prop] : []),
    ...(config.by ? [config.by] : []),
  ]);
  const norm = rows.map((r) => {
    const o: ChartRow = {};
    for (const [k, v] of Object.entries(r)) o[k.toLowerCase()] = v;
    return o;
  });
  const buckets = new Map<string, { label: string } & Cell>();
  // band name (folded) → display name + its cells by x key; first-seen order
  const bands = new Map<string, { name: string; cells: Map<string, Cell> }>();
  let skipped = 0;
  for (const row of norm) {
    let key: string;
    let label: string;
    if (config.x.bucket) {
      const iso = scalarCellString(row[xKey]);
      const date = iso !== undefined ? dateOf(iso) : null;
      if (!date) {
        skipped++;
        continue;
      }
      key = bucketKey(date, config.x.bucket);
      label = bucketLabel(key, config.x.bucket);
    } else {
      const s = categoricalCellString(row[xKey])?.trim();
      if (!s) {
        skipped++;
        continue;
      }
      key = s;
      label = s;
    }
    let yv = 1;
    if (yKey !== null) {
      const n = cellNumber(row[yKey]);
      if (n === null) {
        skipped++;
        continue;
      }
      yv = n;
    }
    // a row with no honest `by` value has no band to land in — skipped like a
    // missing x, rather than inventing an "(none)" series the author didn't ask
    // for
    let bandName: string | null = null;
    if (byKey !== null) {
      const s = categoricalCellString(row[byKey])?.trim();
      if (!s) {
        skipped++;
        continue;
      }
      bandName = s;
    }
    let b = buckets.get(key);
    if (!b) {
      b = { label, sum: 0, n: 0 };
      buckets.set(key, b);
    }
    b.sum += yv;
    b.n += 1;
    if (bandName !== null) {
      const folded = bandName.toLowerCase();
      let band = bands.get(folded);
      if (!band) {
        band = { name: bandName, cells: new Map() };
        bands.set(folded, band);
      }
      let cell = band.cells.get(key);
      if (!cell) {
        cell = { sum: 0, n: 0 };
        band.cells.set(key, cell);
      }
      cell.sum += yv;
      cell.n += 1;
    }
  }
  let points: ChartPoint[] = [...buckets.entries()].map(([key, b]) => ({
    key,
    label: b.label,
    value: reduce(b, config.y.fn),
    n: b.n,
  }));
  if (config.x.bucket) {
    points.sort((a, b) => (a.key < b.key ? -1 : 1));
    // bars: fill empty buckets so periods aren't silently skipped; lines keep
    // only real points (a zero would read as data, and the stroke already
    // implies continuity)
    if (config.kind === "bar") points = zeroFilled(points, config.x.bucket);
  } else if (xOptions?.length) {
    // schema option order first (case-insensitive, like board columns); the
    // sort is stable, so unschematized values keep first-appearance order
    const rank = new Map(xOptions.map((o, i) => [o.value.toLowerCase(), i]));
    const rankOf = (p: ChartPoint) => rank.get(p.key.toLowerCase()) ?? xOptions.length;
    points.sort((a, b) => rankOf(a) - rankOf(b));
  }
  if (byKey === null) return { points, skipped, missing, bands: null };
  const banded: ChartBand[] = [...bands.values()].map((band) => ({
    name: band.name,
    points: points.flatMap((p) => {
      const cell = band.cells.get(p.key);
      if (!cell) return config.kind === "bar" ? [{ ...p, value: 0, n: 0 }] : [];
      return [{ key: p.key, label: p.label, value: reduce(cell, config.y.fn), n: cell.n }];
    }),
  }));
  return { points, skipped, missing, bands: banded };
}

/** One point per named summary of a sheet (SUB-745): the summary binding, for
    charts whose buckets live in the summary bar rather than in rows (a
    per-bucket COUNTIF/SUMIF set). Names resolve case-insensitively, like every
    other summary lookup, and points keep FENCE order — the author's order is
    the axis order, since summaries have no natural one.

    Anything unplottable is a chart-level error rather than a dropped point: a
    two-slice pie missing one slice silently is a lie, and with a handful of
    named series there is no "skipped rows" tail to hide in. Unknown names,
    summaries holding formula errors, and non-numeric summaries all report by
    name. */
export function summarySeries(
  ev: SheetEval,
  names: string[],
): { series: ChartSeries; error: null } | { series: null; error: string } {
  const points: ChartPoint[] = [];
  const bad: string[] = [];
  for (const name of names) {
    const hit = ev.summaries.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!hit) {
      bad.push(`no summary “${name}” on this sheet`);
      continue;
    }
    if (isErr(hit.value)) {
      bad.push(`summary “${hit.name}”: ${hit.value.err}`);
      continue;
    }
    const n = cellNumber(hit.value);
    if (n === null) {
      bad.push(`summary “${hit.name}” is not a number`);
      continue;
    }
    points.push({ key: hit.name.toLowerCase(), label: hit.name, value: n, n: 1 });
  }
  if (bad.length > 0) return { series: null, error: bad.join("; ") };
  return { series: { points, skipped: 0, missing: null, bands: null }, error: null };
}

/** Schema options of a chart's x prop, resolving both the database type and
    the prop name case-insensitively (SUB-679). Both keys are user-authored on
    both sides — the fence and `.vault/schema.json` — and every neighbouring
    step (dbRows, aggregate's row keys) already folds case, so a `source:
    Release` / `x: Status` fence must find the `release`/`status` schema entry.
    Undefined when the type or prop carries no schema. */
export function xSchemaOptions(
  schema: SchemaConfig,
  type: string,
  prop: string,
): SelectOption[] | undefined {
  return propSchemaFor(schema, type, prop)?.options;
}

// ---------- row sources ----------

/** Notes of one database type as chart rows (prop keys lowercased). */
export function dbRows(notes: NoteMeta[], type: string): ChartRow[] {
  const t = type.toLowerCase();
  return notes
    .filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === t)
    .map((n) => {
      const row: ChartRow = { title: n.title };
      for (const [k, v] of Object.entries(n.props)) row[k.toLowerCase()] = v;
      return row;
    });
}

/** Sheet rows as chart rows: data columns (typed) plus computed columns. */
export function sheetRows(model: SheetModel, ev: SheetEval): ChartRow[] {
  const out: ChartRow[] = [];
  for (let i = 0; i < ev.rows.length; i++) {
    const row: ChartRow = {};
    model.headers.forEach((h, c) => (row[h.toLowerCase()] = ev.rows[i][c] ?? null));
    for (const cc of ev.computed) row[cc.name.toLowerCase()] = cc.cells[i] ?? null;
    out.push(row);
  }
  return out;
}

// ---------- display ----------

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Serial day for a bucket key: ISO days directly, month buckets as their 1st
    (UTC serials — pure calendar math, no local-timezone drift). Null for
    categorical keys. */
function dayNumber(key: string): number | null {
  if (isIsoDate(key)) {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / MS_PER_DAY;
  }
  const m = MONTH_KEY_RE.exec(key);
  if (!m) return null;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? Date.UTC(Number(m[1]), mo - 1, 1) / MS_PER_DAY : null;
}

/** Normalized x positions (0..1) for a series' point keys: time-proportional
    when EVERY key parses as a date — ISO days, or month buckets as their 1st —
    so irregular snapshots space by their real gaps and slopes stop lying about
    rate of change; anything else (categorical, mixed) keeps even index spacing.
    Date keys are expected ascending (aggregate() sorts bucketed axes) — an
    unsorted series falls back to even spacing rather than silently re-sorting.
    Duplicate dates share an x; one instant total centers like a single point. */
export function xFractions(keys: string[]): number[] {
  const n = keys.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const even = () => keys.map((_, i) => i / (n - 1));
  const days: number[] = [];
  for (const k of keys) {
    const d = dayNumber(k);
    if (d === null) return even();
    days.push(d);
  }
  for (let i = 1; i < n; i++) if (days[i] < days[i - 1]) return even();
  const span = days[n - 1] - days[0];
  if (span === 0) return keys.map(() => 0.5);
  return days.map((d) => (d - days[0]) / span);
}

/** True when every key is a calendar key (ISO day, or YYYY-MM month). A text
    column carrying pre-bucketed dates — the Spending importer emits exactly
    this shape — is a time axis even though its bucket is null, so it must not
    get categorical treatment (series ramp, unthinned labels). */
export function timelikeKeys(keys: string[]): boolean {
  return keys.length > 0 && keys.every((k) => dayNumber(k) !== null);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Config title, else a quiet derived one ("Release per month", "Sum of amount by category"). */
export function chartTitle(c: ChartConfig): string {
  if (c.title) return c.title;
  // a summary chart has no x/y to describe — the sheet plus "summaries" is the
  // honest derived line ("Holdings summaries")
  if (c.bind === "summaries") {
    return `${cap(c.source.kind === "db" ? c.source.type : c.source.name)} summaries`;
  }
  const per = c.x.bucket ? `per ${c.x.bucket}` : `by ${c.x.prop}`;
  // a `by:` split is the second half of the sentence the title already speaks
  // ("Sum of amount per month, split by category") — the legend names the
  // bands, the title says what the split IS
  const split = c.by ? `, split by ${c.by}` : "";
  if (c.y.fn === "count") {
    const src = c.source.kind === "db" ? c.source.type : c.source.name;
    return `${cap(src)} ${per}${split}`;
  }
  return `${cap(c.y.fn)} of ${c.y.prop} ${per}${split}`;
}

/** Provenance line for the chart foot. */
export function chartSourceDesc(c: ChartConfig): string {
  return c.source.kind === "db" ? `database: ${c.source.type}` : `sheet: ${c.source.name}`;
}
