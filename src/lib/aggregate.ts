import type { AggKind, NumberFormat } from "./types.ts";

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

/* German-typed number input (SUB-636). Display is de-DE everywhere
   (formatNumber → "1.234,56 €"), but storage and every parser here are
   canonical dot-decimal — so text typed back in the app's own dialect used to
   either corrupt silently ("1.234" read as 1,234 → "1,23 €", a 1000× error
   that still looks like money) or drop out of sums entirely ("1.234,56"
   matches no parser, so aggregates skip the row while count counts it).
   These normalize typed text at the commit boundary; YAML stays canonical.

   The grammar is deliberately narrow — dot is read as GROUPING only where a
   de-DE reading is unambiguous or where the app itself produced that shape:

     comma present  → comma is the decimal separator (de-DE has no other use
                      for it). The integer part must be bare digits or
                      well-formed 3-digit groups: "1.234,56"→1234.56,
                      "12,5"→12.5, "-1.234,56"→-1234.56. "1.2.3,4" is neither
                      → left alone.
     no comma, dots → grouping ONLY for the exact shape de-DE rendering emits:
                      1–3 leading digits with a non-zero head, then one or
                      more ".ddd" groups. "1.234"→1234, "1.234.567"→1234567.
                      This is the one genuinely ambiguous case (en 1.234 vs de
                      1234) and it resolves to de, because that shape is what
                      the app rendered into the cell the user is retyping.
                      The non-zero head keeps en decimals like "0.123" out of
                      it, and "1234.56"/"1.5" fail the group shape, so
                      en-style decimals keep working untouched.
     anything else  → returned verbatim; a value we can't read confidently is
                      never rewritten. */
const DE_DECIMAL_RE = /^([+-]?)(\d+|[1-9]\d{0,2}(?:\.\d{3})+),(\d+)$/;
const DE_GROUPED_RE = /^([+-]?)([1-9]\d{0,2}(?:\.\d{3})+)$/;

/** Typed cell text → canonical dot-decimal when it reads as a de-DE number,
    else the text unchanged (trimmed). Only ever called for number-KIND
    columns — other kinds must keep dots and commas verbatim. */
export function normalizeNumberInput(s: string): string {
  const t = s.trim();
  const dec = DE_DECIMAL_RE.exec(t);
  if (dec) return `${dec[1]}${dec[2].replace(/\./g, "")}.${dec[3]}`;
  const grouped = DE_GROUPED_RE.exec(t);
  if (grouped) return `${grouped[1]}${grouped[2].replace(/\./g, "")}`;
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

/** Display form (SUB-245): German grouping with at most 2 decimals
    ("1.234,5"), honoring the column's NumberFormat like the cells do
    (display.ts formatNumber) — euro appends " €", percent " %", plain and
    schema-less columns stay bare. Count stays a plain integer: rows counted
    in a euro column are not euros. The pre-round kills float noise
    (0.1 + 0.2 → "0,3"); `|| 0` normalizes -0. */
export function formatAgg(n: number, kind: AggKind, format?: NumberFormat): string {
  const r = Math.round(n * 100) / 100 || 0;
  const s = r.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  if (kind !== "count" && format === "euro") return `${s} €`;
  if (kind !== "count" && format === "percent") return `${s} %`;
  return s;
}
