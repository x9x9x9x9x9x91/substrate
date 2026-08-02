import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  aggregationKind,
  aggregateColumns,
  formatAgg,
  normalizeNumberInput,
  parseCellNumber,
  parseStrictNumber,
  updateAggregation,
} from "./aggregate.ts";

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
