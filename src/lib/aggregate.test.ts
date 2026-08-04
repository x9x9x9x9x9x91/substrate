import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggMarker,
  aggregate,
  aggregateColumnsUnits,
  aggregateUnits,
  aggregationKind,
  aggregateColumns,
  formatAgg,
  formatUnit,
  normalizeNumberInput,
  parseCellNumber,
  parseStrictNumber,
  updateAggregation,
} from "./aggregate.ts";
import type { FxResolver } from "./formula.ts";

test("sum adds numeric cells, ignores the rest", () => {
  assert.equal(aggregate("sum", ["8", "12", "6", "9", "7"]), 42);
  assert.equal(aggregate("sum", ["1.5", "2.25"]), 3.75);
});

test("avg is the mean of numeric cells", () => {
  assert.equal(aggregate("avg", ["8", "12", "6", "9", "7"]), 8.4);
  assert.equal(aggregate("avg", ["1", "2"]), 1.5);
});

test("min/max over numeric cells", () => {
  assert.equal(aggregate("min", ["8", "12", "6", "9", "7"]), 6);
  assert.equal(aggregate("max", ["8", "12", "6", "9", "7"]), 12);
  assert.equal(aggregate("min", ["-3", "2"]), -3);
});

test("count counts non-empty strings, numeric or not", () => {
  assert.equal(aggregate("count", ["a", "", "  ", "42"]), 2);
  assert.equal(aggregate("count", ["", ""]), 0);
});

test("aggregation records preserve a prototype-shaped column as an own key", () => {
  assert.equal(aggregationKind({}, "__proto__"), undefined);
  assert.equal(aggregationKind({}, "constructor"), undefined);

  const aggs = updateAggregation({}, "__proto__", "sum");
  assert.deepEqual(Object.keys(aggs), ["__proto__"]);
  assert.equal(aggs.__proto__, "sum");
  assert.equal(Object.getPrototypeOf(aggs), null);
  assert.equal(aggregationKind(aggs, "__proto__"), "sum");

  const results = aggregateColumns(aggs, () => ["2", "3"]);
  assert.deepEqual(Object.keys(results), ["__proto__"]);
  assert.equal(results.__proto__, 5);
  assert.equal(Object.getPrototypeOf(results), null);

  const constructors = updateAggregation(aggs, "constructor", "count");
  assert.equal(aggregationKind(constructors, "constructor"), "count");
  assert.equal(aggregationKind(updateAggregation(constructors, "constructor", null), "constructor"), undefined);
});

test("non-numeric cells are ignored by sum/avg/min/max", () => {
  const cells = ["SMP-030", "2026-08-02", "10", "", "n/a", "20"];
  assert.equal(aggregate("sum", cells), 30);
  assert.equal(aggregate("avg", cells), 15);
  assert.equal(aggregate("min", cells), 10);
  assert.equal(aggregate("max", cells), 20);
  // …but they still count
  assert.equal(aggregate("count", cells), 5);
});

test("empty column: no numeric inputs → null; count is 0", () => {
  for (const k of ["sum", "avg", "min", "max"] as const) {
    assert.equal(aggregate(k, []), null);
    assert.equal(aggregate(k, ["", "  ", "n/a"]), null);
  }
  assert.equal(aggregate("count", []), 0);
});

test("parseCellNumber trims, rejects empty and non-numeric", () => {
  assert.equal(parseCellNumber("  42 "), 42);
  assert.equal(parseCellNumber("-3.5"), -3.5);
  assert.equal(parseCellNumber(""), null);
  assert.equal(parseCellNumber("   "), null);
  assert.equal(parseCellNumber("SMP-030"), null);
  assert.equal(parseCellNumber("2026-08-02"), null);
  assert.equal(parseCellNumber("1,234"), null, "locale separators are not parsed");
});

test("parseStrictNumber rejects hex/binary/octal/exponent/Infinity (SUB-221)", () => {
  // bare Number() accepts all of these; the strict parse keeps them text
  for (const bad of ["0x10", "0X10", "0b101", "0o17", "1e3", "1E3", "-1e-3", "Infinity", "-Infinity", "NaN"]) {
    assert.equal(parseStrictNumber(bad), null, `${bad} stays text`);
    assert.equal(parseCellNumber(bad), null, `${bad} never reaches a sum`);
  }
  // plain decimals with optional sign pass, whitespace tolerated
  assert.equal(parseStrictNumber("-12.5"), -12.5);
  assert.equal(parseStrictNumber("+3"), 3);
  assert.equal(parseStrictNumber("42"), 42);
  assert.equal(parseStrictNumber(".5"), 0.5);
  assert.equal(parseStrictNumber("5."), 5);
  assert.equal(parseStrictNumber("  -0.25  "), -0.25);
  // and an "Infinity" cell no longer poisons a footer sum
  assert.equal(aggregate("sum", ["10", "Infinity", "1e3", "0x10", "5"]), 15);
});

test("formatAgg renders de-DE grouping with ≤2 decimals (SUB-245)", () => {
  assert.equal(formatAgg(42, "sum"), "42");
  assert.equal(formatAgg(3.14159, "avg"), "3,14");
  assert.equal(formatAgg(0.1 + 0.2, "sum"), "0,3");
  assert.equal(formatAgg(1.006, "max"), "1,01");
  assert.equal(formatAgg(1234.5, "sum"), "1.234,5");
  assert.equal(formatAgg(1234567.891, "sum"), "1.234.567,89");
  assert.equal(formatAgg(-0.0001, "sum"), "0");
});

test("formatAgg honors the column's NumberFormat like the cells do (SUB-245)", () => {
  assert.equal(formatAgg(1234.5, "sum", "euro"), "1.234,5 €");
  assert.equal(formatAgg(42, "avg", "euro"), "42 €");
  assert.equal(formatAgg(8.5, "avg", "percent"), "8,5 %");
  assert.equal(formatAgg(12, "max", "percent"), "12 %");
  assert.equal(formatAgg(1234.5, "sum", "plain"), "1.234,5");
});

test("formatAgg keeps count a plain integer, even on formatted columns (SUB-245)", () => {
  assert.equal(formatAgg(5, "count", "euro"), "5");
  assert.equal(formatAgg(1234, "count", "percent"), "1.234");
  assert.equal(formatAgg(0, "count"), "0");
});

test("normalizeNumberInput: de-DE decimals become canonical dot-decimal (SUB-636)", () => {
  assert.equal(normalizeNumberInput("1.234,56"), "1234.56");
  assert.equal(normalizeNumberInput("12,5"), "12.5");
  assert.equal(normalizeNumberInput("-1.234,56"), "-1234.56");
  assert.equal(normalizeNumberInput("+0,75"), "+0.75");
  assert.equal(normalizeNumberInput("1.234.567,89"), "1234567.89");
  assert.equal(normalizeNumberInput("  8,5  "), "8.5");
  // and the whole point: they now parse and aggregate
  assert.equal(parseStrictNumber(normalizeNumberInput("1.234,56")), 1234.56);
  assert.equal(aggregate("sum", ["1.234,56", "12,5"].map(normalizeNumberInput)), 1247.06);
});

test("normalizeNumberInput: dotted grouping resolves de, not en (SUB-636)", () => {
  // the ambiguous shape — 1–3 digit non-zero head + ".ddd" groups is exactly
  // what formatNumber renders, so retyping it means 1234, never 1.234
  assert.equal(normalizeNumberInput("1.234"), "1234");
  assert.equal(normalizeNumberInput("12.345"), "12345");
  assert.equal(normalizeNumberInput("123.456"), "123456");
  assert.equal(normalizeNumberInput("1.234.567"), "1234567");
  assert.equal(normalizeNumberInput("-9.999"), "-9999");
});

test("normalizeNumberInput: en-style values keep working untouched (SUB-636)", () => {
  assert.equal(normalizeNumberInput("1234"), "1234");
  assert.equal(normalizeNumberInput("1234.5"), "1234.5");
  assert.equal(normalizeNumberInput("1234.56"), "1234.56");
  assert.equal(normalizeNumberInput("1.5"), "1.5");
  assert.equal(normalizeNumberInput("0.123"), "0.123"); // leading zero ≠ grouping
  assert.equal(normalizeNumberInput("0.5"), "0.5");
  assert.equal(normalizeNumberInput("-0.25"), "-0.25");
  assert.equal(normalizeNumberInput(".5"), ".5");
});

test("normalizeNumberInput: unreadable text is never rewritten (SUB-636)", () => {
  assert.equal(normalizeNumberInput("1.2.3,4"), "1.2.3,4");
  assert.equal(normalizeNumberInput("1.23,4"), "1.23,4"); // 2-digit group ≠ de
  assert.equal(normalizeNumberInput("1.2345"), "1.2345"); // 4-digit group ≠ de
  assert.equal(normalizeNumberInput("1,234,567"), "1,234,567"); // en grouping
  assert.equal(normalizeNumberInput("12,5 €"), "12,5 €");
  assert.equal(normalizeNumberInput("n/a"), "n/a");
  assert.equal(normalizeNumberInput(""), "");
});

// ---------- unit-aware columns (SUB-834) ----------

/** A fixed table so conversions are exact and the tests don't need the app's
    live rates: 1 USD = 0.8 EUR, 1 GBP = 1.2 EUR. Any other pair is unknown,
    which is how a missing rate reaches the code under test. */
const FX: FxResolver = (from, to) => {
  const eur: Record<string, number> = { EUR: 1, USD: 0.8, GBP: 1.2 };
  const f = eur[from];
  const t = eur[to];
  return f === undefined || t === undefined ? null : f / t;
};
const NO_FX: FxResolver = () => null;

test("formatUnit maps a column format to a unit code, euro/percent forever (SUB-834)", () => {
  // the two historical spellings every existing vault carries on disk
  assert.equal(formatUnit("euro"), "EUR");
  assert.equal(formatUnit("percent"), "%");
  // unitless columns
  assert.equal(formatUnit("plain"), null);
  assert.equal(formatUnit(undefined), null);
  // the widened vocabulary: any units.ts code, canonicalized
  assert.equal(formatUnit("USD"), "USD");
  assert.equal(formatUnit("kg"), "kg");
  assert.equal(formatUnit("BPM"), "BPM");
  assert.equal(formatUnit("bpm"), "BPM");
  assert.equal(formatUnit("LUFS"), "LUFS");
  assert.equal(formatUnit("%"), "%");
  // a format naming no unit we know never invents one
  assert.equal(formatUnit("furlongs"), null);
});

test("aggregateUnits on a unitless column is plain aggregate (SUB-834)", () => {
  for (const kind of ["sum", "avg", "min", "max", "count"] as const) {
    const cells = ["8", "12", "6"];
    const got = aggregateUnits(kind, cells, null, FX);
    assert.equal(got.value, aggregate(kind, cells));
    assert.deepEqual(got.converted, []);
    assert.deepEqual(got.skipped, []);
  }
});

test("aggregateUnits converts same-dimension foreign cells into the column unit (SUB-834)", () => {
  // a EUR column holding a bare number, a EUR quantity and a USD one
  const cells = ["10", "20 EUR", "25 USD"];
  const sum = aggregateUnits("sum", cells, "EUR", FX);
  assert.equal(sum.value, 50); // 10 + 20 + 25×0.8
  assert.deepEqual(sum.converted, ["USD"]); // the marker's honesty
  assert.deepEqual(sum.skipped, []);
  // every aggregation sees the converted values, not the raw ones
  assert.equal(aggregateUnits("avg", cells, "EUR", FX).value, 50 / 3);
  assert.equal(aggregateUnits("min", cells, "EUR", FX).value, 10);
  assert.equal(aggregateUnits("max", cells, "EUR", FX).value, 20);
  // symbol and prefix forms convert the same way
  assert.equal(aggregateUnits("sum", ["$25", "€10"], "EUR", FX).value, 30);
});

test("aggregateUnits converts linear units by factor, no FX involved (SUB-834)", () => {
  // a kg column: grams and tonnes are the same dimension
  const got = aggregateUnits("sum", ["2", "500 g", "0.001 t"], "kg", NO_FX);
  assert.equal(got.value, 3.5); // 2 + 0.5 + 1
  assert.deepEqual(got.converted, ["g", "t"]); // sorted, deduped
  assert.deepEqual(got.skipped, []);
});

test("aggregateUnits skips incompatible cells and names their units (SUB-834)", () => {
  // a EUR column holding a mass and a display-only unit: neither is money
  const got = aggregateUnits("sum", ["10", "5 kg", "128 BPM", "25 USD"], "EUR", FX);
  assert.equal(got.value, 30); // 10 + 25×0.8 — kg and BPM never join
  assert.deepEqual(got.converted, ["USD"]);
  assert.deepEqual(got.skipped, ["BPM", "kg"]);
  // display-only units are their own dimension: BPM never mixes with LUFS
  const bpm = aggregateUnits("sum", ["120", "128 BPM", "-14 LUFS"], "BPM", NO_FX);
  assert.equal(bpm.value, 248);
  assert.deepEqual(bpm.skipped, ["LUFS"]);
});

test("aggregateUnits skips a currency it has no rate for, never guesses (SUB-834)", () => {
  // JPY is a currency, so same dimension — but the table can't quote it
  const got = aggregateUnits("sum", ["10", "1000 JPY", "25 USD"], "EUR", FX);
  assert.equal(got.value, 30); // the JPY row is out, exactly like text
  assert.deepEqual(got.converted, ["USD"]);
  assert.deepEqual(got.skipped, ["JPY"]);
  // with no rates at all, only the bare number and the native-unit cell count
  const none = aggregateUnits("sum", ["10", "5 EUR", "25 USD"], "EUR", NO_FX);
  assert.equal(none.value, 15);
  assert.deepEqual(none.converted, []);
  assert.deepEqual(none.skipped, ["USD"]);
});

test("aggregateUnits keeps the column's existing numeric contract (SUB-834)", () => {
  // text is skipped silently as ever — no unit to name, no marker
  const got = aggregateUnits("sum", ["10", "ask", "", "  ", "n/a"], "EUR", FX);
  assert.equal(got.value, 10);
  assert.deepEqual(got.skipped, []);
  // the strict grammar still rules bare cells: no hex, no exponents, no
  // Infinity, and "1,234" is still not a number here (parseCellNumber, not
  // the de-DE input normalizer)
  assert.equal(aggregateUnits("sum", ["10", "0x10", "1e3", "Infinity", "1,234"], "EUR", FX).value, 10);
  // nothing numeric at all → null, like aggregate
  assert.equal(aggregateUnits("sum", ["ask", ""], "EUR", FX).value, null);
  assert.equal(aggregateUnits("sum", [], "EUR", FX).value, null);
  // a unit we don't know leaves the value as text, not a bare number
  assert.equal(aggregateUnits("sum", ["10", "25 furlongs"], "EUR", FX).value, 10);
});

test("aggregateUnits leaves count alone — rows are not euros (SUB-834)", () => {
  // every non-empty cell counts, convertible or not
  const got = aggregateUnits("count", ["10", "25 USD", "5 kg", "ask", ""], "EUR", FX);
  assert.equal(got.value, 4);
  assert.deepEqual(got.converted, []);
  assert.deepEqual(got.skipped, []);
});

test("formatAgg renders any unit, euro/percent byte-identically (SUB-834)", () => {
  // the historical two render exactly as they did before units landed
  assert.equal(formatAgg(1234.5, "sum", "euro"), "1.234,5 €");
  assert.equal(formatAgg(8.5, "avg", "percent"), "8,5 %");
  // and the widened vocabulary rides the same de-DE dialect
  assert.equal(formatAgg(1234.5, "sum", "USD"), "1.234,5 $");
  assert.equal(formatAgg(3.5, "sum", "kg"), "3,5 kg");
  assert.equal(formatAgg(128, "avg", "BPM"), "128 BPM");
  assert.equal(formatAgg(-14.2, "min", "LUFS"), "-14,2 LUFS");
  // count stays bare on a unit column, as on a euro one
  assert.equal(formatAgg(5, "count", "kg"), "5");
  // the intl dialect swaps the separators, suffix unchanged
  assert.equal(formatAgg(1234.5, "sum", "euro", "intl"), "1,234.5 €");
  assert.equal(formatAgg(1234.5, "sum", "kg", "intl"), "1,234.5 kg");
  // an unreadable format is unitless, never invented
  assert.equal(formatAgg(1234.5, "sum", "furlongs"), "1.234,5");
});

test("aggMarker says what a mixed figure actually did (SUB-834)", () => {
  const mark = (converted: string[], skipped: string[], asOf?: string) =>
    aggMarker({ value: 1, converted, skipped }, asOf);
  assert.equal(mark(["USD"], [], "2026-08-03"), "Converted USD at 2026-08-03 rates");
  assert.equal(mark(["GBP", "USD"], [], "2026-08-03"), "Converted GBP, USD at 2026-08-03 rates");
  // no date to claim → no date clause, rather than a rate we can't date
  assert.equal(mark(["USD"], []), "Converted USD");
  assert.equal(mark(["USD"], [], "  "), "Converted USD");
  // the honest half: what was LEFT OUT is named too
  assert.equal(mark([], ["kg"]), "Skipped kg — not convertible");
  assert.equal(
    mark(["USD"], ["JPY", "kg"], "2026-08-03"),
    "Converted USD at 2026-08-03 rates · Skipped JPY, kg — not convertible"
  );
  // a figure that needs no marker gets none — no asterisk on a clean column
  assert.equal(mark([], []), null);
  assert.equal(aggMarker(undefined), null);
  assert.equal(aggMarker({ value: null, converted: [], skipped: [] }), null);
});

test("aggregateColumnsUnits folds each column in its own unit (SUB-834)", () => {
  const cells: Record<string, string[]> = {
    price: ["10", "25 USD"], // EUR column, one foreign row
    weight: ["2", "500 g"], // kg column, no rates needed
    tally: ["3", "4"], // unitless
  };
  const units: Record<string, string | null> = { price: "EUR", weight: "kg", tally: null };
  const got = aggregateColumnsUnits(
    { price: "sum", weight: "sum", tally: "sum" },
    (c) => cells[c],
    (c) => units[c],
    FX
  );
  assert.equal(got.price.value, 30);
  assert.deepEqual(got.price.converted, ["USD"]);
  assert.equal(got.weight.value, 2.5);
  assert.deepEqual(got.weight.converted, ["g"]);
  assert.equal(got.tally.value, 7);
  assert.deepEqual(got.tally.converted, [], "a unitless column never claims a conversion");
  // the prototype-shaped-column guard survives the unit-aware path (an object
  // literal can't express this: `__proto__:` there sets the prototype)
  const proto = aggregateColumnsUnits(
    updateAggregation({}, "__proto__", "sum"),
    () => ["2", "3"],
    () => null,
    FX
  );
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal(proto.__proto__.value, 5);
  assert.equal(Object.getPrototypeOf(proto), null);
});
