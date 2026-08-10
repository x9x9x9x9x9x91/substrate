import { test } from "node:test";
import assert from "node:assert/strict";
import { CALC_ERR_DISPLAY, evalCalcDoc, fencedLines, hasExecutableCalcLine, isCalcLine } from "./calc.ts";
import type { FxResolver } from "./formula.ts";
import type { NumberLocale } from "./numberLocale.ts";

// USD→EUR and GBP→EUR only; every other pair is "no rate", which is what the
// error paths below exercise.
const fx: FxResolver = (from, to) => {
  if (from === to) return 1;
  if (from === "USD" && to === "EUR") return 0.9;
  if (from === "EUR" && to === "USD") return 1 / 0.9;
  if (from === "GBP" && to === "EUR") return 1.2;
  return null;
};
const noFx: FxResolver = (from, to) => (from === to ? 1 : null);

/** One document, one line's answer. */
const calc = (body: string, line = 0, resolver: FxResolver = fx, locale: NumberLocale = "de-DE") =>
  evalCalcDoc(body.split("\n"), resolver, locale).get(line);

/** The formatted display of a line, asserting it wasn't an error. */
const shown = (body: string, line = 0, resolver: FxResolver = fx, locale: NumberLocale = "de-DE") => {
  const r = calc(body, line, resolver, locale);
  assert.ok(r, `expected a calc result on line ${line}`);
  assert.equal(r.err, undefined, `unexpected error: ${r.err}`);
  return r.display;
};

/** The error message of a line, asserting it failed. */
const failed = (body: string, line = 0, resolver: FxResolver = fx) => {
  const r = calc(body, line, resolver);
  assert.ok(r, `expected a calc result on line ${line}`);
  assert.equal(r.display, CALC_ERR_DISPLAY);
  assert.ok(r.err, "expected an error message");
  return r.err;
};

// ---------- line detection ----------

test("isCalcLine takes = at line start, with up to three spaces", () => {
  assert.equal(isCalcLine("= 1 + 1"), true);
  assert.equal(isCalcLine("=1+1"), true);
  assert.equal(isCalcLine("   = 1 + 1"), true);
  // four spaces is an indented code block to every other markdown reader
  assert.equal(isCalcLine("    = 1 + 1"), false);
  assert.equal(isCalcLine("x = 1 + 1"), false);
  assert.equal(isCalcLine("- = 1 + 1"), false);
  assert.equal(isCalcLine(""), false);
});

test("isCalcLine ignores setext underlines and a lone =", () => {
  assert.equal(isCalcLine("==="), false);
  assert.equal(isCalcLine("="), false);
  assert.equal(isCalcLine("=  "), false);
});

test("non-calc lines get no result at all", () => {
  const doc = ["a note", "x = 12", "", "1 + 1"];
  const out = evalCalcDoc(doc, fx, "de-DE");
  assert.equal(out.size, 0);
});

test("fencedLines marks the fence and everything inside it", () => {
  const lines = ["before", "```ts", "= 1 + 1", "```", "after"];
  assert.deepEqual([...fencedLines(lines)].sort((a, b) => a - b), [1, 2, 3]);
});

test("fences close only with the opener marker and at least its run length", () => {
  const lines = [
    "````js",
    "= hidden: 1",
    "~~~",
    "= stillHidden: 2",
    "```",
    "= stillHiddenToo: 3",
    "`````",
    "= visible: 4",
  ];
  assert.deepEqual([...fencedLines(lines)], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(hasExecutableCalcLine(lines.join("\n")), true);
  const onlyCode = ["~~~js", "= hidden: 1", "```", "= hiddenToo: 2", "~~~~"];
  assert.equal(hasExecutableCalcLine(onlyCode.join("\n")), false);
});

test("skipped lines neither compute nor bind", () => {
  const lines = ["```", "= x: 5", "```", "= x + 1"];
  const out = evalCalcDoc(lines, fx, "de-DE", fencedLines(lines));
  assert.equal(out.has(1), false);
  assert.equal(out.get(3)?.err, "unknown name “x”");
});

// ---------- arithmetic ----------

test("arithmetic and precedence", () => {
  assert.equal(shown("= 1 + 1"), "2");
  assert.equal(shown("= 2 + 3 * 4"), "14");
  assert.equal(shown("= (2 + 3) * 4"), "20");
  assert.equal(shown("= 10 / 4"), "2,5");
  assert.equal(shown("= -3 + 10"), "7");
  assert.equal(shown("= -(2 + 3)"), "-5");
  assert.equal(shown("= 2 * -3"), "-6");
});

test("division by zero is a quiet error", () => {
  assert.equal(failed("= 1 / 0"), "division by zero");
  assert.equal(failed("= 5 kg / 0 kg"), "division by zero");
});

test("number-suffix shorthand", () => {
  assert.equal(shown("= 3.9M", 0, fx, "en-US"), "3,900,000");
  assert.equal(shown("= 12k"), "12.000");
  assert.equal(shown("= 12K"), "12.000");
  assert.equal(shown("= 2B", 0, fx, "en-US"), "2,000,000,000");
  assert.equal(shown("= 1.5M + 500k", 0, fx, "en-US"), "2,000,000");
});

test("shorthand does not eat a unit that starts with the same letter", () => {
  assert.equal(shown("= 12kB"), "12 KB");
  assert.equal(shown("= 3 km"), "3 km");
});

test("German decimals parse", () => {
  assert.equal(shown("= 1.234,56 + 1"), "1.235,56");
  assert.equal(shown("= 12,5 * 2"), "25");
  assert.equal(shown("= 1.234,56", 0, fx, "en-US"), "1,234.56");
});

test("junk inside a calc line is a quiet error, not a crash", () => {
  assert.ok(failed("= 1 +").length > 0);
  assert.ok(failed("= )(").length > 0);
  assert.ok(failed("= 5 furlongs").length > 0);
  assert.equal(failed("= (1 + 2"), "expected “)”");
});

// ---------- units ----------

test("units flow through addition in the left operand's unit", () => {
  assert.equal(shown("= 5 kg + 500 g"), "5,5 kg");
  assert.equal(shown("= 500 g + 5 kg"), "5.500 g");
  assert.equal(shown("= 1 h - 30 min"), "0,5 h");
});

test("a bare number adopts its partner's unit", () => {
  assert.equal(shown("= 100 € + 19"), "119 €");
  assert.equal(shown("= 19 + 100 €"), "119 €");
});

test("mixed dimensions are a quiet error", () => {
  assert.equal(failed("= 5 kg + 3 m"), "can't convert m to kg");
  assert.equal(failed("= 120 BPM + 4 dB"), "can't convert dB to BPM");
});

test("multiplication and division carry the unit", () => {
  assert.equal(shown("= 5 kg * 3"), "15 kg");
  assert.equal(shown("= 3 * 5 kg"), "15 kg");
  assert.equal(shown("= 15 kg / 3"), "5 kg");
  // same dimension → the units cancel into a ratio
  assert.equal(shown("= 15 kg / 500 g"), "30");
  assert.equal(failed("= 5 kg * 3 m"), "can't multiply kg by m");
  assert.equal(failed("= 3 / 5 kg"), "can't divide a plain number by kg");
});

test("currency symbols lead or trail their number", () => {
  assert.equal(shown("= $25 + $5", 0, fx, "en-US"), "30 $");
  assert.equal(shown("= 25 USD + 5 USD", 0, fx, "en-US"), "30 $");
  assert.equal(shown("= € 1.234,56"), "1.234,56 €");
});

test("currency addition converts through fx", () => {
  assert.equal(shown("= 10 EUR + 10 USD"), "19 €");
  assert.equal(failed("= 10 EUR + 10 JPY"), "no FX rate for JPY→EUR");
  assert.equal(failed("= 10 EUR + 10 USD", 0, noFx), "no FX rate for USD→EUR");
});

// ---------- `in <unit>` ----------

test("trailing `in` converts the whole expression", () => {
  assert.equal(shown("= 25 USD in EUR"), "22,50 €");
  assert.equal(shown("= 5 kg in g"), "5.000 g");
  assert.equal(shown("= 1 kg + 1 kg in g"), "2.000 g");
  assert.equal(shown("= 90 min in h"), "1,5 h");
});

test("`in` across dimensions or without a rate errors quietly", () => {
  assert.equal(failed("= 5 kg in EUR"), "can't convert kg to EUR");
  assert.equal(failed("= 25 USD in EUR", 0, noFx), "no FX rate for USD→EUR");
  assert.equal(failed("= 42 in kg"), "that number has no unit to convert from");
});

test("an unknown `in` target stays part of the expression", () => {
  // "in progress" is prose, not a conversion — it fails as an expression
  assert.ok(failed("= 5 in progress").length > 0);
});

// ---------- variables ----------

test("a calc line binds a variable later lines can read", () => {
  const doc = ["= rate: 85 €", "= hours: 12", "= rate * hours"];
  assert.equal(shown(doc.join("\n"), 2), "1.020 €");
  // the binding line still shows its own value
  assert.equal(shown(doc.join("\n"), 0), "85 €");
});

test("variable names are case-insensitive and unicode", () => {
  const doc = ["= Größe: 5 kg", "= größe * 2"];
  assert.equal(shown(doc.join("\n"), 1), "10 kg");
});

test("a forward reference is an unknown name, not zero", () => {
  const doc = ["= total * 2", "= total: 10"];
  assert.equal(failed(doc.join("\n"), 0), "unknown name “total”");
  assert.equal(shown(doc.join("\n"), 1), "10");
});

test("prose assignments never bind", () => {
  const doc = ["budget: 500 €", "budget = 500", "= budget + 1"];
  assert.equal(failed(doc.join("\n"), 2), "unknown name “budget”");
});

test("a later binding of the same name wins for lines below it", () => {
  const doc = ["= x: 1", "= x + 1", "= x: 10", "= x + 1"];
  assert.equal(shown(doc.join("\n"), 1), "2");
  assert.equal(shown(doc.join("\n"), 3), "11");
});

test("an errored binding leaves the name unbound", () => {
  const doc = ["= x: 5 kg + 3 m", "= x + 1"];
  assert.ok(failed(doc.join("\n"), 0).length > 0);
  assert.equal(failed(doc.join("\n"), 1), "unknown name “x”");
});

// ---------- line aggregates ----------

test("sum totals the contiguous run directly above", () => {
  const doc = ["12", "8", "= sum"];
  assert.equal(shown(doc.join("\n"), 2), "20");
});

test("avg and count over the same run", () => {
  const doc = ["12", "8", "4", "= avg"];
  assert.equal(shown(doc.join("\n"), 3), "8");
  const counted = ["12", "8", "4", "= count"];
  assert.equal(shown(counted.join("\n"), 3), "3");
});

test("aggregate keywords are case-insensitive", () => {
  const doc = ["1", "2", "= SUM"];
  assert.equal(shown(doc.join("\n"), 2), "3");
});

test("list markers are stripped from run lines", () => {
  const doc = ["- 12,50 €", "* 7,50 €", "1. 5 €", "= sum"];
  assert.equal(shown(doc.join("\n"), 3), "25 €");
});

test("an empty line stops the run", () => {
  const doc = ["100", "", "12", "8", "= sum"];
  assert.equal(shown(doc.join("\n"), 4), "20");
});

test("a non-numeric line stops the run", () => {
  const doc = ["Groceries", "12", "8", "= sum"];
  assert.equal(shown(doc.join("\n"), 3), "20");
});

test("another calc line stops the run", () => {
  const doc = ["12", "= 4 + 4", "6", "= sum"];
  assert.equal(shown(doc.join("\n"), 3), "6");
});

test("sum with nothing above it is a quiet error", () => {
  assert.equal(failed("= sum"), "no numbers directly above this line");
  assert.equal(failed(["text", "= avg"].join("\n"), 1), "no numbers directly above this line");
});

test("count with nothing above it is zero, not an error", () => {
  assert.equal(shown("= count"), "0");
});

test("a mixed-currency run converts into the first line's unit", () => {
  const doc = ["10 EUR", "10 USD", "= sum"];
  assert.equal(shown(doc.join("\n"), 2), "19 €");
  const usdFirst = ["10 USD", "10 EUR", "= sum"];
  assert.equal(shown(usdFirst.join("\n"), 2), "21,11 $");
});

test("a run whose units don't convert errors quietly", () => {
  const doc = ["10 EUR", "10 JPY", "= sum"];
  assert.equal(failed(doc.join("\n"), 2), "no FX rate for JPY→EUR");
  const dims = ["5 kg", "3 m", "= sum"];
  assert.equal(failed(dims.join("\n"), 2), "can't convert m to kg");
});

test("a bare number inside a unit run just adds", () => {
  const doc = ["10 €", "5", "= sum"];
  assert.equal(shown(doc.join("\n"), 2), "15 €");
});

test("a unit line under a plain-number run is an error", () => {
  const doc = ["10", "5 kg", "= sum"];
  assert.equal(failed(doc.join("\n"), 2), "can't add kg to a plain number");
});

test("an aggregate binds and converts like any other line", () => {
  const doc = ["1 kg", "500 g", "= total: sum in g", "= total / 2"];
  assert.equal(shown(doc.join("\n"), 2), "1.500 g");
  assert.equal(shown(doc.join("\n"), 3), "750 g");
});

// ---------- formatting ----------

test("the locale picks the dialect of the result", () => {
  assert.equal(shown("= 1234.5 + 0", 0, fx, "de-DE"), "1.234,5");
  assert.equal(shown("= 1234.5 + 0", 0, fx, "en-US"), "1,234.5");
});

test("float noise is rounded away", () => {
  assert.equal(shown("= 0.1 + 0.2", 0, fx, "en-US"), "0.3");
});

// ---------- a realistic note ----------

test("a whole shopping-list note computes end to end", () => {
  const doc = [
    "# Studio spend",
    "",
    "- 1.234,56 €",
    "- 89,90 €",
    "- 12,50 €",
    "= subtotal: sum",
    "= subtotal * 0,19",
    "= subtotal in USD",
    "",
    "not a calc line",
  ];
  const out = evalCalcDoc(doc, fx, "de-DE");
  assert.deepEqual([...out.keys()], [5, 6, 7]);
  assert.equal(out.get(5)?.display, "1.336,96 €");
  assert.equal(out.get(6)?.display, "254,02 €");
  assert.equal(out.get(7)?.display, "1.485,51 $");
});
