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
// A sheet's named summaries plot too, one point per summary, instead
// of x/y over rows — so a per-bucket COUNTIF/SUMIF set charts without
// materializing bucket rows in the sheet:
//
//   ```chart
//   source: {{Holdings}}
//   series: etf, crypto, cash  # named summaries on that sheet
//   ```
//
// An optional `by: <prop|column>` splits the y measure into one series per
// distinct value of that field — stacked bars, multi-line:
//
//   ```chart
//   source: expense
//   x: spent:month
//   y: sum:amount
//   by: category        # one series per category
//   ```
//
// A `history:` fence plots one frontmatter fact's own past instead of rows
// (docs/time-travel-spec.md §3.3) — the chart half of time travel:
//
//   ```chart
//   history: Assets/BTC.md#price   # <note path>#<frontmatter key>
//   x: month                       # day | week | month (default day)
//   y: last                        # last | avg | min | max (default last)
//   kind: line
//   ```
//
// `size: tall` is the one bounded style token a chart takes — a NAME
// from a closed roster, never a height in px. An unknown name is simply not
// honored (the chart draws at its default size) rather than failing the fence.
// It rides on every binding above, style being orthogonal to where points
// come from.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { parseStrictNumber } from "./aggregate.ts";
import { isIsoDate, MONTHS, todayIso, toIso } from "./dates.ts";
import { isErr } from "./formula.ts";
import { endOfLocalDay, isoDayOf, valueAt } from "./history-facts.ts";
import { propSchemaFor } from "./schemalookup.ts";
import { parseChartSize, type ChartSize } from "./styletokens.ts";
import type { SheetEval, SheetModel } from "./sheet.ts";
import type { FactLane, NoteMeta, SchemaConfig, SelectOption } from "./types.ts";
import { foldedPropStr } from "./types.ts";

export type ChartBucket = "day" | "week" | "month";
export type ChartKind = "bar" | "line";

export type ChartSource = { kind: "db"; type: string } | { kind: "sheet"; name: string };

export type ChartAgg = { fn: "count" } | { fn: "sum" | "avg"; prop: string };

export interface ChartAxis {
  prop: string;
  bucket: ChartBucket | null; // null = categorical axis (select prop / text column)
}

/** How a bucket of a fact's history reduces to one point (§3.3). `last` is the
    default because §2.1 already answers "what was it on day D" with the day's
    closing value — the chart says the same thing per bucket. */
export type HistoryReduce = "last" | "avg" | "min" | "max";

/** The fact a `history:` chart plots: one frontmatter key on one note. */
export interface HistoryFactRef {
  path: string;
  key: string;
}

/** How a chart gets its points. `rows` is the original binding: bucket the
    source's rows by `x`, reduce with `y`. `summaries` names sheet
    summaries instead — one point per named summary, no rows involved — so a
    per-bucket COUNTIF/SUMIF set charts without materializing bucket rows.
    `history` plots one fact's past: the x axis IS time, so it takes
    a bare bucket rather than a property, and there is no source to bind — the
    fact names its own note. */
export type ChartBind =
  | { bind: "rows"; source: ChartSource; x: ChartAxis; y: ChartAgg; by: string | null }
  | { bind: "summaries"; source: ChartSource; series: string[] }
  | { bind: "history"; fact: HistoryFactRef; x: ChartBucket; y: HistoryReduce };

export type ChartConfig = {
  kind: ChartKind;
  title: string | null;
  /** bounded style token: `size: tall`, or null for the default
      plot. A name, never a height — see src/lib/styletokens.ts. */
  size: ChartSize | null;
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
  /** The `by:` split, null for a single-measure chart. Bands share
      the x axis: every band lists the SAME keys in the same order, so a bar
      stacks and a line reads point-for-point against its neighbours. */
  bands: ChartBand[] | null;
  /** An in-place note the chart prints beside the plot rather than in place of
      it — "no history before 2026-01-05" (§3.3, Open call 1): the points that
      predate the oldest surviving snapshot are omitted, and saying so is the
      difference between a short chart and a wrong one. Null when there is
      nothing to disclose. */
  note?: string | null;
}

/** One series of a `by:`-split chart — the distinct value plus its points. */
export interface ChartBand {
  name: string; // the distinct `by` value, in its first-seen casing
  points: ChartPoint[];
}

// ---------- config parsing ----------

const KNOWN_KEYS = new Set([
  "source",
  "x",
  "y",
  "kind",
  "title",
  "series",
  "by",
  "history",
  "size",
]);
const BUCKETS = new Set(["day", "week", "month"]);
const REDUCERS = new Set(["last", "avg", "min", "max"]);

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

/** `history: <note path>#<frontmatter key>` — the fact whose past to plot.
    The `{{Sheet}}#member` form is in the spec but not in this slice, so it
    says so by name instead of failing as an unfindable path. Slice 1 is one
    fact per fence (§3.3), so a comma list is named too rather than plotting
    only the first. */
function parseHistoryFact(v: string): HistoryFactRef {
  if (v.includes(",")) {
    throw new Error("history plots one fact — split the rest into their own chart fences");
  }
  if (/^\{\{/.test(v.trim())) {
    throw new Error("history of a sheet summary isn't supported yet — name a note path#key");
  }
  const at = v.lastIndexOf("#");
  if (at < 0) throw new Error(`history must be <note path>#<key> — got "${v}"`);
  const path = v.slice(0, at).trim();
  const key = v.slice(at + 1).trim();
  if (!path) throw new Error("history must name a note path before the #");
  if (!key) throw new Error("history must name a frontmatter key after the #");
  return { path, key };
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
  const kindRaw = (kv.get("kind") ?? "bar").toLowerCase();
  if (kindRaw !== "bar" && kindRaw !== "line") {
    throw new Error(`kind must be bar or line — got "${kv.get("kind")}"`);
  }
  // `size` is a style token, not a binding: an off-roster value is a
  // preference we can't honor, so it falls back to the default plot rather than
  // failing a fence whose data is perfectly good. Bindings still throw. It sits
  // on the shared head, above the binding split, so a `history:` chart takes
  // the token on the same terms a row chart does.
  const head = {
    kind: kindRaw as ChartKind,
    title: kv.get("title") ?? null,
    size: parseChartSize(kv.get("size")) ?? null,
  };

  // `history` is the time binding (spec §3.3): the fact IS the source and
  // the x axis IS time, so a fence carrying `source:` or `series:` too has
  // named its data twice — say which to drop rather than letting one win.
  if (kv.has("history")) {
    if (kv.has("source")) {
      throw new Error("history charts plot one fact's past — drop source, or drop history");
    }
    if (kv.has("series")) {
      throw new Error("history charts plot one fact's past — drop series, or drop history");
    }
    if (kv.has("by")) {
      throw new Error("by splits a row measure — drop by, or drop history");
    }
    const bucketRaw = (kv.get("x") ?? "day").toLowerCase();
    if (!BUCKETS.has(bucketRaw)) {
      throw new Error(`unknown x bucket "${kv.get("x")}" — want day, week or month`);
    }
    const reduceRaw = (kv.get("y") ?? "last").toLowerCase();
    if (!REDUCERS.has(reduceRaw)) {
      throw new Error(`y must be last, avg, min or max — got "${kv.get("y")}"`);
    }
    return {
      ...head,
      bind: "history",
      fact: parseHistoryFact(kv.get("history")!),
      x: bucketRaw as ChartBucket,
      y: reduceRaw as HistoryReduce,
    };
  }

  if (!kv.has("source")) throw new Error(`missing required key "source"`);
  const source = parseSource(kv.get("source")!);

  // `series` is the summary binding; it replaces x/y rather than joining them,
  // so a fence that carries both is a mistake worth naming rather than one of
  // the two silently winning.
  if (kv.has("series")) {
    if (kv.has("x") || kv.has("y")) {
      throw new Error("series charts plot summaries — drop x and y, or drop series");
    }
    // `by` splits a row measure into series; `series` already IS the series
    // list. Both together name the same axis twice, so say which one to drop
    // rather than letting one quietly win.
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
    return { ...head, source, bind: "summaries", series };
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
    source,
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

/** Same label with the year spelled out, for a window that spans more than one
    of them — "Jul 17" alone reads as this year. */
function bucketLabelWithYear(key: string, bucket: ChartBucket): string {
  if (bucket === "month") return bucketLabel(key, bucket);
  const [y, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d} ${y}`;
}

/** The bucket key that follows `key` on the time axis. */
function nextBucketKey(key: string, bucket: ChartBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  if (bucket === "month") return toIso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1).slice(0, 7);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + (bucket === "week" ? 7 : 1));
  return toIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/** The bucket key before `key` — the axis walked backwards, which is how the
    history window is cut: from today, not from the oldest snapshot. */
function prevBucketKey(key: string, bucket: ChartBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  if (bucket === "month") return toIso(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 1).slice(0, 7);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - (bucket === "week" ? 7 : 1));
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

// ---------- history series (spec §3.3) ----------

/** First instant of a bucket, in the reader's timezone — the same calendar
    `endOfLocalDay` uses, so a chart and an `AT()` cell agree about where a day
    ends. */
function bucketStartMs(key: string, bucket: ChartBucket): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, bucket === "month" ? 1 : d).getTime();
}

// A `day` chart of a years-old fact would plot a point per day forever. Keep
// the most recent stretch — the window is cut backwards from TODAY, so the
// current value is always on the chart — and say the axis was cut, rather than
// thinning points silently or refusing to draw.
export const MAX_HISTORY_POINTS = 400;

/** One fact's past as chart points (§3.3): buckets from its first recorded
    change to today, each reduced by `y`.

    `last` is the bucket's closing value — the same answer `AT(<last day>, …)`
    gives, so the chart and a cell never disagree. `avg`/`min`/`max` range over
    the values the fact actually HELD during the bucket, which includes the one
    carried in from before it: a price that never changed in March still has a
    March average.

    Buckets before the oldest surviving snapshot are omitted rather than drawn
    flat back to the beginning of time, and `note` says so — the charting half
    of Open call 1. Non-numeric values (a status word, a date) are counted in
    `skipped`, because a chart can only plot numbers. */
export function historySeries(
  lane: FactLane,
  bucket: ChartBucket,
  reduce: HistoryReduce,
  today: string = todayIso()
): ChartSeries {
  const empty = (note: string | null): ChartSeries => ({
    points: [],
    skipped: 0,
    missing: null,
    bands: null,
    note,
  });
  if (lane.oldest_ts_ms === null) return empty("this vault has no version history yet");
  const note = `no history before ${isoDayOf(lane.oldest_ts_ms)}`;
  // The vault HAS history and this key never appears in it — a typo'd key, or
  // one that was only ever written outside the covered stretch. Reporting the
  // trim boundary here would blame the trim for a key that was never recorded.
  if (lane.points.length === 0) return empty("no value has been recorded for this key");

  const ceiling = endOfLocalDay(today);
  if (ceiling === null) return empty(note);
  const endKey = bucketKey(today, bucket);
  const oldestKey = bucketKey(isoDayOf(lane.points[0].ts_ms), bucket);
  if (oldestKey > endKey) return empty(note);

  // Walk the window backwards from today first, so the stretch that gets
  // plotted is the most recent one and the loop below is bounded by the cap
  // rather than by the age of the fact. Collecting oldest-first and slicing
  // afterwards would drop today off the right edge of a long lane.
  let startKey = endKey;
  for (let i = 1; i < MAX_HISTORY_POINTS && startKey > oldestKey; i += 1) {
    startKey = prevBucketKey(startKey, bucket);
  }
  if (startKey < oldestKey) startKey = oldestKey;
  const truncated = startKey > oldestKey;
  // "Jul 17" reads as this year; a window that crosses a year boundary says
  // which one it means.
  const spansYears = startKey.slice(0, 4) !== endKey.slice(0, 4);
  const labelOf = (k: string) =>
    spansYears ? bucketLabelWithYear(k, bucket) : bucketLabel(k, bucket);

  const points: ChartPoint[] = [];
  let skipped = 0;
  for (let k = startKey; k <= endKey; k = nextBucketKey(k, bucket)) {
    const start = bucketStartMs(k, bucket);
    const end = Math.min(bucketStartMs(nextBucketKey(k, bucket), bucket) - 1, ceiling);
    if (end < start) break;
    const samples: number[] = [];
    const take = (raw: string) => {
      const n = parseStrictNumber(raw);
      if (n === null) skipped += 1;
      else samples.push(n);
    };
    if (reduce === "last") {
      const at = valueAt(lane, end);
      if (at.kind === "value") take(at.value);
    } else {
      // the value carried into the bucket counts: a fact that did not change
      // this month still held a value all month
      const carried = valueAt(lane, start - 1);
      if (carried.kind === "value") take(carried.value);
      for (const p of lane.points) {
        if (p.ts_ms >= start && p.ts_ms <= end && p.value !== null) take(p.value);
      }
    }
    if (samples.length === 0) continue;
    const value =
      reduce === "min"
        ? Math.min(...samples)
        : reduce === "max"
          ? Math.max(...samples)
          : reduce === "avg"
            ? samples.reduce((a, b) => a + b, 0) / samples.length
            : samples[samples.length - 1];
    points.push({ key: k, label: labelOf(k), value, n: samples.length });
  }

  return {
    points,
    skipped,
    missing: null,
    bands: null,
    note: truncated
      ? `${note} · showing from ${bucketLabelWithYear(startKey, bucket)}`
      : note,
  };
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
    than collapsing into "[object Object]". */
function categoricalCellString(v: unknown): string | undefined {
  const scalar = scalarCellString(v);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(v) && v.every((item) => typeof item === "string")) return v.join(", ");
  return undefined;
}

/** One cell as a y value. Strings parse strictly (the same
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

    With `by` the same rows additionally pivot into one band per
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

// ---------- band ramp slots ----------

/** What one chart remembers about its own `by:` split, across renders: which
    ramp slot each series value holds. Folded value → slot. Insertion order is
    least-recently-present first, so eviction has somewhere honest to start.
    Owned by the chart that renders it and dies with it — nothing is persisted
    to the vault. */
export type BandSlotMemory = Map<string, number>;

/** Which chart a `BandSlotMemory` belongs to. A dashboard renders
    its chart fences from a list, so nothing about a chart's POSITION there can
    identify it: delete the first fence of two and the second slides up into the
    first's place — and, keyed on position, would inherit the first's colour
    memory and be recoloured around series it has never shown. Same bug class as
    the one this issue kills, one level up.

    The key is what decides which series a split can show — the source and the
    `by:` prop (a summary chart names its points instead, and has no split at
    all; a `history:` chart has no source AND no split — the fact IS its
    subject, so its note and key are what it is). Presentation is deliberately
    NOT in it: retitling a chart, or flipping it between bar and line, keeps the
    colours the reader already learned. Nor are `x`/`y`, which change the
    numbers a series is worth, never its identity.

    Total over every binding by construction: each arm of `ChartBind` answers
    here, so a new binding cannot silently fall through to a `source` that does
    not exist on it — the prune effect in `ChartsDashboard` calls this for EVERY
    block on the page, so an unhandled arm is a runtime throw on the whole
    dashboard rather than one bad colour.

    Two fences with the same source and the same split therefore share one
    memory, which is the point rather than a collision: `done` should be the
    same green in both charts on a dashboard that splits by status twice. The
    cost is paid when they show DISJOINT slices of that split: three fences
    filtered to two series each share one 5-slot memory, and a series absent
    from the render that evicts it can come back wearing a different colour.
    Sharing is still the better default — the same value reading the same in
    two charts is what a reader checks first — and the eviction order (least
    recently present) keeps the flap to splits that genuinely outrun the ramp.

    Case is folded, like every other user-authored key in this file. */
export function chartIdentity(c: ChartConfig): string {
  if (c.bind === "history") return `history:${c.fact.path.toLowerCase()}#${c.fact.key.toLowerCase()}`;
  const src = c.source.kind === "db" ? `db:${c.source.type.toLowerCase()}` : `sheet:${c.source.name.toLowerCase()}`;
  if (c.bind === "summaries") return `${src}|summaries:${c.series.map((s) => s.toLowerCase()).join("\u0000")}`;
  return `${src}|by:${(c.by ?? "").toLowerCase()}`;
}

/** Assign each band its ramp slot, keyed on the series' IDENTITY rather than
    its position in the split.

    `aggregate()` builds bands in the data's first-seen order, so before this a
    series' colour was a function of where it happened to fall: delete every
    `etf` row and `crypto` — orange a moment ago — was redrawn in slot 1's blue.
    Self-consistent within any one render (the legend always agreed with the
    slices), wrong across renders, which is the only way a person reads a
    dashboard chart they keep open.

    The contract this holds: a series that was on screen a render ago keeps its
    slot as long as it is still on screen, whatever happened to the rows around
    it. A series the chart has never shown takes the lowest free slot, and NEW
    series are served in first-appearance order — so a chart's very first render
    (nothing remembered) still walks the ramp from slot 1 downward, which is
    what the fixed-order invariant asserts.

    `memory` is mutated in place: it is the chart's, and this is the only writer.
    Eviction: it never grows past `capacity`, and only a series that is ABSENT
    from this render can be evicted — the least recently present one first. A
    split that oscillates between more distinct values than the ramp has slots
    will therefore eventually recolour something; there is no fix for that short
    of an unbounded registry, and forgetting the series nobody has seen for
    longest is the least surprising thing to forget.

    Total by construction: with more bands than `capacity` the tail gets slots at
    and above `capacity`, which no token styles. The render path stops a 6th
    series with a message before it ever draws, so that tail is unreachable in
    the app — it exists so this function has no undefined case. */
export function assignBandSlots(
  bands: readonly { name: string }[],
  memory: BandSlotMemory,
  capacity: number,
): number[] {
  const folded = bands.map((b) => b.name.toLowerCase());
  const slots = new Array<number>(bands.length).fill(-1);
  const taken = new Set<number>();

  // 1. survivors first — a remembered series keeps the slot it is wearing
  folded.forEach((name, i) => {
    const slot = memory.get(name);
    if (slot !== undefined && !taken.has(slot)) {
      slots[i] = slot;
      taken.add(slot);
    }
  });

  // 2. then the new ones, in first-appearance order, lowest free slot each.
  //    A slot still reserved by an absent series is not free until every
  //    unreserved slot is gone — that is what keeps a series' colour through a
  //    render where its rows happen to be filtered out.
  const reserved = new Set<number>();
  for (const [name, slot] of memory) if (!taken.has(slot) && !folded.includes(name)) reserved.add(slot);
  let overflow = capacity;
  folded.forEach((_name, i) => {
    if (slots[i] !== -1) return;
    let slot = -1;
    for (let s = 0; s < capacity; s++) {
      if (!taken.has(s) && !reserved.has(s)) {
        slot = s;
        break;
      }
    }
    if (slot === -1) {
      // every slot is spoken for; the oldest absent series gives one up
      const stale = [...memory].find(([, s]) => reserved.has(s));
      if (stale) {
        memory.delete(stale[0]);
        reserved.delete(stale[1]);
        slot = stale[1];
      } else {
        slot = overflow++; // more bands than the ramp has slots — see docstring
      }
    }
    slots[i] = slot;
    taken.add(slot);
  });

  // 3. rewrite the memory so present series are the most recently seen, which
  //    makes step 2's "oldest absent" the actual least-recently-present one
  const absent = [...memory].filter(([name]) => !folded.includes(name));
  memory.clear();
  for (const [name, slot] of absent) if (!taken.has(slot)) memory.set(name, slot);
  folded.forEach((name, i) => {
    if (slots[i] < capacity) memory.set(name, slots[i]);
  });
  // backstop, unreachable today: step 3 only ever re-seeds entries holding
  // distinct slots below `capacity`, so the map cannot outgrow the ramp. Kept
  // so a future change to the seeding above degrades by forgetting the oldest
  // rather than by growing without bound.
  for (const name of [...memory.keys()]) {
    if (memory.size <= capacity) break;
    memory.delete(name);
  }
  return slots;
}

/** One point per named summary of a sheet: the summary binding, for
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
    the prop name case-insensitively. Both keys are user-authored on
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
    get categorical treatment (unthinned labels). */
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
  // a history chart's subject is the fact itself, and its x axis is always
  // time — "Price per month" reads the way the fence does
  if (c.bind === "history") {
    const reduced = c.y === "last" ? cap(c.fact.key) : `${cap(c.y)} ${c.fact.key}`;
    return `${reduced} per ${c.x}`;
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
  // history reads its own note, not a database or a sheet — the provenance
  // line names the fact so the foot still answers "where is this from"
  if (c.bind === "history") return `history: ${c.fact.path}#${c.fact.key}`;
  return c.source.kind === "db" ? `database: ${c.source.type}` : `sheet: ${c.source.name}`;
}
