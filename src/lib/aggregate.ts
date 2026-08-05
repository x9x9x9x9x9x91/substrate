import type { AggKind, NumberFormat } from "./types.ts";
import type { FxResolver } from "./formula.ts";
import { isErr } from "./formula.ts";
import {
  DEFAULT_NUMBER_LOCALE,
  NUMBER_GRAMMARS,
  numberLocale,
  type NumberLocale,
} from "./numberLocale.ts";
import { convert, formatQuantity, parseQuantity, resolveUnit, sameDimension } from "./units.ts";

// units.ts imports this module's number grammar (normalizeNumberInput,
// parseStrictNumber) and this module imports its unit vocabulary: a genuine
// ESM cycle, and a safe one — neither side touches the other at module-init
// time, and every binding crossing the seam is a hoisted `function`. Keep it
// that way: a `const` arrow exported across this seam and called from the
// other module's top level would land in the TDZ.

/** Table-footer aggregations (SUB-74): Notion-style "Calculate" over the
    visible rows of one column. Cell values are strings (props are strings) —
    sum/avg/min/max parse strictly (`parseStrictNumber`) and skip non-numeric
    cells; count counts non-empty strings. */

/** The one numeric coercion for cell strings (SUB-221), shared by the footer
    aggregates, the formula engine and sheet cell typing: a decimal integer
    or float with an optional sign — nothing else. Bare `Number()` also
    accepts hex ("0x10"), binary ("0b101"), octal, exponents ("1e3") and
    Infinity; those stay text here, so a stray "Infinity" cell can't poison a
    SUM. Whitespace around the literal is ignored; anything else — empty
    included — reads as null. */
export function parseStrictNumber(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  return Number(t);
}

/* Locale-typed number input (SUB-636, made locale-aware in SUB-1092). Display
   goes through the number-locale dial ("1.234,56 €" in de-DE, "1,234.56" in
   en-US, "1'234.56" in de-CH…), but storage and every parser here are
   canonical dot-decimal — so text typed back in the app's OWN dialect would
   either corrupt silently (de "1.234" read as 1,234 → "1,23 €", a 1000× error
   that still looks like money) or drop out of sums entirely ("1.234,56"
   matches no parser, so aggregates skip the row while count counts it). These
   normalize typed text at the commit boundary; YAML stays canonical.

   Before SUB-1092 the grammar was hardwired German, which moved the same bug
   onto every other dial position: under en-US the app rendered 1234 as
   "1,234" and read that back as 1.234, and "1'234"/"1 234,56" were NaN.

   The grammar is per-locale and deliberately narrow — a group separator is
   read as grouping only where that locale's reading is unambiguous or where
   the app itself produced that shape:

     decimal sep    → it splits. The integer part must be bare digits or
       present        well-formed 3-digit groups of THIS locale's group
                      separator: de-DE "1.234,56"→1234.56, "12,5"→12.5,
                      en-US "1,234.56"→1234.56, fr-FR "1 234,56"→1234.56.
                      "1.2.3,4" is neither → left alone.
     no decimal sep,→ grouping ONLY for the exact shape this locale renders:
       group seps     1–3 leading digits with a non-zero head, then one or
                      more "sep+ddd" groups. de-DE "1.234"→1234, en-US
                      "1,234"→1234, de-CH "1'234"→1234. de-DE's is the one
                      genuinely ambiguous case (en 1.234 vs de 1234) and it
                      still resolves to de, because that shape is what the app
                      rendered into the cell the user is retyping. The
                      non-zero head keeps decimals like "0.123" out of it, and
                      "1234.56"/"1.5" fail the group shape — so under a
                      dot-decimal locale canonical storage text round-trips
                      untouched, as it must.
     anything else  → returned verbatim; a value we can't read confidently is
                      never rewritten. */

function escRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

interface Grammar {
  decimal: RegExp;
  grouped: RegExp;
  strip: RegExp;
}

const GRAMMARS = new Map<NumberLocale, Grammar>();

function grammar(locale: NumberLocale): Grammar {
  const hit = GRAMMARS.get(locale);
  if (hit) return hit;
  const g = NUMBER_GRAMMARS[locale];
  const sep = `[${g.groups.map(escRe).join("")}]`;
  const grouped = `[1-9]\\d{0,2}(?:${sep}\\d{3})+`;
  const built: Grammar = {
    decimal: new RegExp(`^([+-]?)(\\d+|${grouped})${escRe(g.decimal)}(\\d+)$`),
    grouped: new RegExp(`^([+-]?)(${grouped})$`),
    strip: new RegExp(sep, "g"),
  };
  GRAMMARS.set(locale, built);
  return built;
}

/** Typed cell text → canonical dot-decimal when it reads as a number in
    `locale`, else the text unchanged (trimmed). Only ever called for
    number-KIND columns — other kinds must keep dots and commas verbatim.

    `locale` defaults to the module binding (numberLocale.ts), i.e. whatever
    the ⌘, dial last read out of Settings.md: the commit boundary is not
    memoized, so the binding is always current by the time a keystroke lands.
    Call sites that already hold the locale as a prop may pass it. */
export function normalizeNumberInput(s: string, locale: NumberLocale = numberLocale()): string {
  const t = s.trim();
  const g = grammar(locale);
  const dec = g.decimal.exec(t);
  if (dec) return `${dec[1]}${dec[2].replace(g.strip, "")}.${dec[3]}`;
  const grouped = g.grouped.exec(t);
  if (grouped) return `${grouped[1]}${grouped[2].replace(g.strip, "")}`;
  return t;
}

/** One cell as aggregation input: the parsed number, or null when the cell
    is empty or non-numeric (dates, text, "SMP-030"…). */
export function parseCellNumber(v: string): number | null {
  return parseStrictNumber(v);
}

/** Aggregate one column's cell strings. Returns null when the aggregation
    has no inputs (sum/avg/min/max over zero numeric cells) — the footer
    renders the label with no value then. Count always has a value. */
export function aggregate(kind: AggKind, values: string[]): number | null {
  if (kind === "count") return values.filter((v) => v.trim() !== "").length;
  const nums = values.map(parseCellNumber).filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  switch (kind) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

/** A column's format as a unit code (SUB-834), or null when the column is
    unitless (`plain`, absent, or a format naming no unit we know — an
    unreadable format never invents a unit). `euro` and `percent` are the two
    historical spellings every existing vault carries on disk; they resolve to
    EUR and % forever, so widening the vocabulary needed no migration. */
export function formatUnit(format: NumberFormat | undefined): string | null {
  if (!format || format === "plain") return null;
  if (format === "euro") return "EUR";
  if (format === "percent") return "%";
  return resolveUnit(format)?.code ?? null;
}

/** What a unit-aware aggregate did (SUB-834). `value` is the aggregation in
    the column's own unit — null when nothing fed it, exactly like
    `aggregate`. `converted` names the foreign units that were converted into
    it, sorted, so the footer can mark the figure instead of quietly mixing
    currencies. `skipped` names the units that could NOT join: a different
    dimension, or a currency with no rate. Both empty = the figure is as
    honest as a single-unit column's. */
export interface UnitAgg {
  value: number | null;
  converted: string[];
  skipped: string[];
}

/** One cell as a number in `unit` (SUB-834), with the foreign unit it came
    from when a conversion happened.

    A cell carrying a unit routes through units.ts; EVERYTHING ELSE keeps the
    strict grammar (`parseCellNumber`) it has always had, so a column's
    existing numeric contract is untouched — "1,234" is still not a number
    here, in the footer as on the cell, even though parseQuantity would read
    it as a de-DE 1.234. Widening that is a separate decision from units.

    A foreign-unit cell that can't join — different dimension, unknown unit,
    a currency with no rate — comes back null with its unit named, so callers
    skip it the way they already skip text and can still say which. */
export function cellInUnit(
  v: string,
  unit: string,
  fx: FxResolver
): { n: number | null; from: string | null } {
  const q = parseQuantity(v);
  if (!q || q.unit === null) return { n: parseCellNumber(v), from: null };
  if (q.unit === unit) return { n: q.value, from: null };
  if (!sameDimension(q.unit, unit)) return { n: null, from: q.unit };
  const c = convert(q, unit, fx);
  // same dimension but no rate — never guess a number, skip and say which
  return isErr(c) ? { n: null, from: q.unit } : { n: c, from: q.unit };
}

/** Unit-aware column aggregation (SUB-834): `aggregate` for a column that
    carries a unit. Same-dimension cells in a foreign unit are converted into
    the column's unit and counted; incompatible or rate-less ones are skipped
    exactly as non-numeric text already is, and named in `skipped` so the
    footer can say so. `count` is unchanged — it counts non-empty cells, which
    no unit affects.

    A unitless column (`formatUnit` → null) is just `aggregate` with empty
    marker lists, so one call site covers every column. */
export function aggregateUnits(
  kind: AggKind,
  values: string[],
  unit: string | null,
  fx: FxResolver
): UnitAgg {
  if (kind === "count" || unit === null) {
    return { value: aggregate(kind, values), converted: [], skipped: [] };
  }
  const nums: number[] = [];
  const converted = new Set<string>();
  const skipped = new Set<string>();
  for (const v of values) {
    if (v.trim() === "") continue;
    const c = cellInUnit(v, unit, fx);
    if (c.n === null) {
      if (c.from) skipped.add(c.from);
      continue;
    }
    if (c.from) converted.add(c.from);
    nums.push(c.n);
  }
  const marks = { converted: [...converted].sort(), skipped: [...skipped].sort() };
  if (nums.length === 0) return { value: null, ...marks };
  switch (kind) {
    case "sum":
      return { value: nums.reduce((a, b) => a + b, 0), ...marks };
    case "avg":
      return { value: nums.reduce((a, b) => a + b, 0) / nums.length, ...marks };
    case "min":
      return { value: Math.min(...nums), ...marks };
    case "max":
      return { value: Math.max(...nums), ...marks };
  }
}

/** The footer marker's hover text (SUB-834): what a mixed-unit aggregation
    actually did, so a converted figure never passes for a plain total. null
    when the figure needs no marker — nothing converted and nothing skipped,
    which is every unitless column and every column whose rows all share the
    column's unit. `asOf` dates the rates when it's known. */
export function aggMarker(agg: UnitAgg | undefined, asOf?: string): string | null {
  if (!agg || (agg.converted.length === 0 && agg.skipped.length === 0)) return null;
  const parts: string[] = [];
  if (agg.converted.length > 0) {
    const at = asOf && asOf.trim() ? ` at ${asOf.trim()} rates` : "";
    parts.push(`Converted ${agg.converted.join(", ")}${at}`);
  }
  // the honest half: naming what was LEFT OUT matters more than what came in
  if (agg.skipped.length > 0) parts.push(`Skipped ${agg.skipped.join(", ")} — not convertible`);
  return parts.join(" · ");
}

/** Null-prototype records keep absent prototype-shaped column names absent,
    while still preserving an explicitly stored `__proto__`/`constructor` as
    an own data key. */
function aggregationRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/** An aggregation selected for one column, own keys only. Preferences arrive
    through JSON as ordinary objects, so a direct read of an absent
    `constructor`/`__proto__` would otherwise see Object.prototype. */
export function aggregationKind(
  aggs: Readonly<Record<string, AggKind>>,
  column: string
): AggKind | undefined {
  return Object.prototype.hasOwnProperty.call(aggs, column) ? aggs[column] : undefined;
}

export function aggregateColumns(
  aggs: Readonly<Record<string, AggKind>>,
  valuesFor: (column: string) => string[]
): Record<string, number | null> {
  return aggregationRecord(
    Object.entries(aggs).map(
      ([column, kind]) => [column, aggregate(kind, valuesFor(column))] as const
    )
  );
}

/** `aggregateColumns` for unit-aware columns (SUB-834): each column folds in
    its own unit (`unitFor`, from the column's schema format) and reports what
    the conversion cost, so the footer can mark a mixed figure. A column with
    no unit comes back as the plain aggregation with empty marker lists. */
export function aggregateColumnsUnits(
  aggs: Readonly<Record<string, AggKind>>,
  valuesFor: (column: string) => string[],
  unitFor: (column: string) => string | null,
  fx: FxResolver
): Record<string, UnitAgg> {
  return aggregationRecord(
    Object.entries(aggs).map(
      ([column, kind]) =>
        [column, aggregateUnits(kind, valuesFor(column), unitFor(column), fx)] as const
    )
  );
}

export function updateAggregation(
  aggs: Readonly<Record<string, AggKind>>,
  column: string,
  kind: AggKind | null
): Record<string, AggKind> {
  const next = aggregationRecord(Object.entries(aggs));
  if (kind === null) delete next[column];
  else next[column] = kind;
  return next;
}

/** Display form (SUB-245): the dial's grouping with at most 2 decimals
    ("1.234,5" in de-DE, "1,234.5" in en-US), honoring the column's
    NumberFormat like the cells do
    (display.ts formatNumber) — euro appends " €", percent " %", plain and
    schema-less columns stay bare. Since SUB-834 any units.ts code does the
    same through the unit's own suffix ("1.234,5 kg", "128 BPM"); euro and
    percent still route through EUR and % and still render byte-identically.
    Count stays a plain integer: rows counted in a euro column are not euros.
    The pre-round kills float noise (0.1 + 0.2 → "0,3"); `|| 0` normalizes -0.

    `locale` picks the number dialect. It arrived in SUB-834 as a two-value
    "de"/"intl" flag and became a full BCP-47 tag from NUMBER_LOCALES in
    SUB-1092; it still defaults to DEFAULT_NUMBER_LOCALE, so a call site that
    threads nothing renders exactly as it always did. */
export function formatAgg(
  n: number,
  kind: AggKind,
  format?: NumberFormat,
  locale: NumberLocale = DEFAULT_NUMBER_LOCALE
): string {
  const unit = kind === "count" ? null : formatUnit(format);
  return formatQuantity(n, unit, locale);
}
