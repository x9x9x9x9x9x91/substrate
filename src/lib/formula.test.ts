import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { todayIso } from "./dates.ts";
import {
  collectCrossRefs,
  collectRefs,
  evaluate,
  ferr,
  hasAggregate,
  isErr,
  looseEq,
  parseFormula,
  renameRefs,
  type FxResolver,
  type Scope,
  type ScopedValue,
  type Value,
} from "./formula.ts";

const fx: FxResolver = (from, to) => {
  if (from === "USD" && to === "EUR") return 0.8721;
  if (from === "EUR" && to === "USD") return 1 / 0.8721;
  return null;
};

function run(src: string, scope: Scope = new Map(), today?: () => string): Value | unknown[] {
  const expr = parseFormula(src);
  if (isErr(expr)) return expr;
  return evaluate(expr, scope, fx, today) as Value;
}

function near(v: Value | unknown[], expected: number, eps = 1e-9) {
  assert.equal(typeof v, "number", `expected number, got ${JSON.stringify(v)}`);
  assert.ok(Math.abs((v as number) - expected) < eps, `${v} != ${expected}`);
}

test("arithmetic with precedence and parens", () => {
  assert.equal(run("2 + 3 * 4"), 14);
  assert.equal(run("(2 + 3) * 4"), 20);
  assert.equal(run("10 / 4"), 2.5);
  assert.equal(run("-3 * 2"), -6);
  assert.equal(run("1 - -1"), 2);
  assert.equal(run("2 * (3 + 4) - 5"), 9);
});

test("division by zero is an error, not Infinity", () => {
  assert.ok(isErr(run("1 / 0")));
});

test("string literals with doubled-quote escape", () => {
  assert.equal(run('"hello"'), "hello");
  assert.equal(run('"a""b"'), 'a"b');
});

test("comparisons: numbers, strings case-insensitive, numeric strings", () => {
  assert.equal(run("1 < 2"), true);
  assert.equal(run("2 >= 3"), false);
  assert.equal(run('"a" = "A"'), true);
  assert.equal(run('"crypto" <> "etf"'), true);
  assert.equal(run('"3" = 3'), true);
  assert.equal(looseEq(null, null), true);
  assert.equal(looseEq(null, 0), false);
});

test("comparisons: a blank cell never satisfies < > <= >= (SUB-238)", () => {
  const row: Scope = new Map([["b", null]]);
  assert.equal(run("b < 10", row), false);
  assert.equal(run("b > -5", row), false);
  assert.equal(run("b <= 10", row), false);
  assert.equal(run("b >= 10", row), false);
  // blank on the right side is no comparison either
  assert.equal(run("10 > b", row), false);
  // …so IF no longer fires on empty rows
  assert.equal(run('IF(b < 10, "hit", "miss")', row), "miss");
  // numeric and string compares are untouched
  assert.equal(run("5 < 10"), true);
  assert.equal(run('"a" < "b"'), true);
  assert.equal(run('"b" > "a"'), true);
  // equality keeps its own null rules (blank = blank, blank <> value)
  assert.equal(run("b = 0", row), false);
  assert.equal(run("b <> 0", row), true);
});

test("IF is lazy: untaken branch errors don't leak", () => {
  assert.equal(run('IF(1 = 1, 5, 1 / 0)'), 5);
  assert.equal(run('IF(1 = 2, 1 / 0, "ok")'), "ok");
  assert.equal(run("IF(0, 1, 2)"), 2);
});

test("ROUND halves away from zero, like Excel", () => {
  assert.equal(run("ROUND(2.5, 0)"), 3);
  assert.equal(run("ROUND(-2.5, 0)"), -3);
  near(run("ROUND(3.14159, 2)"), 3.14);
  assert.equal(run("ROUND(7, 0)"), 7);
});

test("ROUND shifts in decimal space: float-representation halves land right (SUB-221)", () => {
  // 1.005 * 100 is 100.49999… as a double — decimal shifting gets 1.01
  assert.equal(run("ROUND(1.005, 2)"), 1.01);
  assert.equal(run("ROUND(2.675, 2)"), 2.68);
  assert.equal(run("ROUND(-1.005, 2)"), -1.01);
  // plain half-away-from-zero cases hold
  assert.equal(run("ROUND(1.5, 0)"), 2);
  assert.equal(run("ROUND(-1.5, 0)"), -2);
  // negative digits and zero still work
  assert.equal(run("ROUND(1500, -3)"), 2000);
  assert.equal(run("ROUND(0, 2)"), 0);
});

test("numeric coercion is strict: hex/exponent/Infinity strings stay text (SUB-221)", () => {
  const col: Scope = new Map([["c", ["10", "1e3", "0x10", "Infinity", "5"]]]);
  assert.equal(run("SUM(c)", col), 15, "loose-parse strings can't poison a SUM");
  assert.equal(run("COUNT(c)", col), 2);
  // in arithmetic they're an error, not a number
  const row: Scope = new Map([["n", "1e3"]]);
  assert.ok(isErr(run("n * 2", row)));
  const inf: Scope = new Map([["n", "Infinity"]]);
  assert.ok(isErr(run("n * 2", inf)));
  // plain numeric strings still coerce, empty is 0
  const ok: Scope = new Map([["n", "-12.5"]]);
  assert.equal(run("n * 2", ok), -25);
  const blank: Scope = new Map([["n", ""]]);
  assert.equal(run("n + 5", blank), 5);
});

test("negating a non-number errors like the binary path, never NaN", () => {
  // -x used to negate the FErr object itself, yielding NaN: the cell rendered
  // the literal "NaN" instead of !, and any SUM over that column went NaN too
  const bad: Scope = new Map([["n", "n/a"]]);
  assert.ok(isErr(run("-n", bad)));
  assert.ok(isErr(run("n * -1", bad)), "binary path already errored — unary now matches");
  const strict: Scope = new Map([["n", "1e3"]]);
  assert.ok(isErr(run("-n", strict)));
  // real numbers, numeric strings and blanks still negate
  const ok: Scope = new Map([["n", "-12.5"]]);
  assert.equal(run("-n", ok), 12.5);
  const blank: Scope = new Map([["n", ""]]);
  assert.ok(run("-n", blank) === 0, "blank negates to zero (-0 compares equal)");
});

test("FX uses the resolver, identity is 1, missing pair errors", () => {
  near(run('FX("USD", "EUR")'), 0.8721);
  assert.equal(run('FX("USD", "USD")'), 1);
  assert.ok(isErr(run('FX("USD", "JPY")')));
});

test("date arithmetic: date ± days stays on the local calendar across boundaries", () => {
  assert.equal(run('"2026-01-31" + 1'), "2026-02-01", "month boundary");
  assert.equal(run('"2025-12-31" + 1'), "2026-01-01", "year boundary");
  assert.equal(run('"2026-03-01" - 1'), "2026-02-28", "plain February");
  assert.equal(run('"2024-02-28" + 1'), "2024-02-29", "leap February");
  assert.equal(run('"2024-12-31" + 1'), "2025-01-01", "leap year ends too");
  assert.equal(run('"2026-07-17" + 0'), "2026-07-17");
  // Europe/Berlin springs forward 2026-03-29 — calendar math, not ms math
  assert.equal(run('"2026-03-28" + 2'), "2026-03-30", "spans a DST transition");
  // addition commutes; a date column works as the operand
  assert.equal(run('7 + "2026-07-17"'), "2026-07-24");
  const row: Scope = new Map([["bought", "2026-07-01"]]);
  assert.equal(run("bought + 30", row), "2026-07-31");
  // fractional day counts truncate toward zero (no time component to carry one)
  assert.equal(run('"2026-07-17" + 1.9'), "2026-07-18");
  assert.equal(run('"2026-07-17" - 1.9'), "2026-07-16");
  // blank is 0 in arithmetic, dates included (Excel's empty-cell rule)
  const blank: Scope = new Map([["d", null]]);
  assert.equal(run('"2026-07-17" + d', blank), "2026-07-17");
});

test("date arithmetic: date − date is a signed whole-day count", () => {
  assert.equal(run('"2026-07-17" - "2026-07-10"'), 7);
  assert.equal(run('"2026-07-10" - "2026-07-17"'), -7);
  assert.equal(run('"2026-07-17" - "2026-07-17"'), 0);
  assert.equal(run('"2026-01-01" - "2025-12-31"'), 1, "year boundary");
  assert.equal(run('"2024-03-01" - "2024-02-01"'), 29, "leap February");
  assert.equal(run('"2026-04-01" - "2026-03-01"'), 31, "spans a DST transition");
});

test("date arithmetic errors follow engine conventions", () => {
  const add = run('"2026-07-17" + "2026-07-10"');
  assert.ok(isErr(add) && /can't add two dates/.test(add.err), "date + date");
  const sub = run('1 - "2026-07-17"');
  assert.ok(isErr(sub) && /can't subtract a date from a number/.test(sub.err), "number − date");
  const text = run('"2026-07-17" + "soon"');
  assert.ok(isErr(text) && /day count is not a number/.test(text.err), "non-numeric day count");
  assert.ok(isErr(run('"2026-07-17" * 2')), "no date multiplication");
  assert.ok(isErr(run('"2026-07-17" / 2')), "no date division");
  // date-shaped text that isn't ISO stays text and hits the numeric path
  assert.ok(isErr(run('"2026-7-17" + 1')), "unpadded is not a date");
});

test("TODAY() returns the clock's local day, re-read on every evaluation (SUB-717)", () => {
  const days = ["2026-07-31", "2026-08-01"];
  let i = 0;
  const clock = () => days[Math.min(i++, days.length - 1)];
  assert.equal(run("TODAY()", new Map(), clock), "2026-07-31");
  // volatile: the next evaluation re-reads the clock — no first-compute freeze
  assert.equal(run("TODAY()", new Map(), clock), "2026-08-01");
  // and it composes with date arithmetic
  i = 0;
  assert.equal(run('TODAY() - "2026-07-01"', new Map(), clock), 30);
  const withArg = run("TODAY(1)");
  assert.ok(isErr(withArg) && /takes no arguments/.test(withArg.err));
});

test("TODAY() without an injected clock is the app's local today", () => {
  // Same local-day source the app uses (dates.ts), not a wall-clock literal —
  // the only flake window is midnight landing between the two calls.
  assert.equal(run("TODAY()"), todayIso());
});

const holdingsScope: Scope = new Map([
  ["asset", ["GLOW", "BTC", "ARC"]],
  ["bucket", ["etf", "crypto", "etf"]],
  ["units", [1200, 4.1, 80]],
  ["price_usd", [31.4, 64200, 92.5]],
  ["value_eur", [32863.128, 229502.56, 6454.37]],
]);

test("aggregates over columns (spreadsheet portfolio tracker semantics)", () => {
  assert.equal(run("SUM(units)", holdingsScope), 1284.1);
  near(run("AVG(price_usd)", holdingsScope), (31.4 + 64200 + 92.5) / 3);
  assert.equal(run("MIN(units)", holdingsScope), 4.1);
  assert.equal(run("MAX(units)", holdingsScope), 1200);
  assert.equal(run("COUNT(units)", holdingsScope), 3);
  // Excel COUNT: numeric cells only — text column counts 0
  assert.equal(run("COUNT(asset)", holdingsScope), 0);
});

test("LAST: last non-empty cell in row order, value as-is", () => {
  const scope: Scope = new Map([
    ["gap", [1, null, 2, null]],
    ["blanktail", ["a", "b", ""]],
    ["wsonly", [null, "  "]],
    ["dates", ["2026-07-01", null, "2026-07-30"]],
    ["empty", [null, null]],
  ]);
  assert.equal(run("LAST(gap)", scope), 2, "nulls are skipped");
  assert.equal(run("LAST(blanktail)", scope), "b", "blank strings are skipped");
  assert.equal(run("LAST(dates)", scope), "2026-07-30", "dates are plain strings, no coercion");
  assert.equal(run("LAST(asset)", holdingsScope), "ARC", "strings pass through");
  assert.equal(run("LAST(units)", holdingsScope), 80);
  // 0 and false are values, not empty
  const falsy: Scope = new Map([
    ["z", [5, 0]],
    ["b", [true, false]],
  ]);
  assert.equal(run("LAST(z)", falsy), 0);
  assert.equal(run("LAST(b)", falsy), false);
  // all-empty column: an error, matching MAX over an empty set
  assert.ok(isErr(run("LAST(empty)", scope)));
  assert.ok(isErr(run("LAST(wsonly)", scope)), "whitespace-only strings are empty");
  // error cells propagate like every other aggregate
  const broken: Scope = new Map([["bad", [1, ferr("boom"), 2]]]);
  assert.ok(isErr(run("LAST(bad)", broken)));
  // scalar arg and missing arg are errors
  assert.ok(isErr(run("LAST(1 + 2)")));
  assert.ok(isErr(run("LAST()")));
});

test("SUMIF / COUNTIF with criteria", () => {
  near(run('SUMIF(bucket, "etf", value_eur)', holdingsScope), 32863.128 + 6454.37);
  near(run('SUMIF(bucket, "crypto", value_eur)', holdingsScope), 229502.56);
  assert.equal(run('COUNTIF(bucket, "etf")', holdingsScope), 2);
  // two-arg SUMIF sums the criteria column itself
  assert.equal(run("SUMIF(units, 80)", holdingsScope), 80);
});

// SUB-1026: rows pair off criteria against values, so a value column of a
// different length (a cross-sheet ref) errors like SUMPRODUCT instead of
// silently reading the overhang as blank rows that sum to 0
test("SUMIF: mismatched value-column length is an error (SUB-1026)", () => {
  const scope: Scope = new Map([
    ["bucket", ["etf", "etf", "etf"]],
    ["amt", [1, 2]],
    ["long", [1, 2, 3, 4]],
  ]);
  const short = run('SUMIF(bucket, "etf", amt)', scope);
  assert.ok(isErr(short) && /same number of rows/.test(short.err), JSON.stringify(short));
  assert.ok(isErr(run('SUMIF(bucket, "etf", long)', scope)));
  // equal lengths keep working, multi-criteria form included
  const even: Scope = new Map([
    ["bucket", ["etf", "stock", "etf"]],
    ["amt", [1, 2, 4]],
    ["flag", ["y", "y", "n"]],
  ]);
  near(run('SUMIF(bucket, "etf", amt)', even), 5);
  near(run('SUMIF(bucket, "etf", amt, flag, "y")', even), 1);
});

// SUB-743: comparison criteria strings in SUMIF/COUNTIF
const scoreScope: Scope = new Map([
  ["score", [0, 1, 2.5, 5, -1]],
  ["weight", [10, 20, 30, 40, 50]],
  ["label", ["alpha", "beta", "gamma", "delta", "epsilon"]],
  ["mixed", [1, "two", 3]],
  ["sparse", [0, null, 2, "", 4]],
]);

test("SUMIF / COUNTIF comparison criteria (SUB-743)", () => {
  // every comparator, on the criteria column itself and with a value column
  assert.equal(run('COUNTIF(score, ">=1")', scoreScope), 3); // 1, 2.5, 5
  assert.equal(run('COUNTIF(score, ">1")', scoreScope), 2); // 2.5, 5
  assert.equal(run('COUNTIF(score, "<=1")', scoreScope), 3); // 0, 1, -1
  assert.equal(run('COUNTIF(score, "<1")', scoreScope), 2); // 0, -1
  assert.equal(run('COUNTIF(score, "<>0")', scoreScope), 4); // all but the 0
  near(run('SUMIF(score, ">=1", weight)', scoreScope), 20 + 30 + 40);
  near(run('SUMIF(score, ">1", weight)', scoreScope), 30 + 40);
  near(run('SUMIF(score, "<=1", weight)', scoreScope), 10 + 20 + 50);
  near(run('SUMIF(score, "<0", weight)', scoreScope), 50);
  near(run('SUMIF(score, "<>0", weight)', scoreScope), 20 + 30 + 40 + 50);
  // two-arg form sums the criteria column itself
  near(run('SUMIF(score, ">=1")', scoreScope), 1 + 2.5 + 5);

  // boundary inclusivity: >= includes the boundary, > does not; same for <=/<
  assert.equal(run('COUNTIF(score, ">=2.5")', scoreScope), 2);
  assert.equal(run('COUNTIF(score, ">2.5")', scoreScope), 1);
  assert.equal(run('COUNTIF(score, "<=-1")', scoreScope), 1);
  assert.equal(run('COUNTIF(score, "<-1")', scoreScope), 0);

  // decimals and negative operands parse
  assert.equal(run('COUNTIF(score, ">=-1")', scoreScope), 5);
  assert.equal(run('COUNTIF(score, ">0.5")', scoreScope), 3);

  // whitespace around the operand is tolerated
  assert.equal(run('COUNTIF(score, ">= 1")', scoreScope), 3);

  // blanks never satisfy a comparison, not even "<>"
  assert.equal(run('COUNTIF(sparse, ">=0")', scoreScope), 3); // 0, 2, 4
  assert.equal(run('COUNTIF(sparse, "<>9")', scoreScope), 3);

  // numeric criteria over a non-numeric column errors honestly
  const bad = run('COUNTIF(mixed, ">=1")', scoreScope);
  assert.ok(isErr(bad) && /needs numbers/.test(bad.err), JSON.stringify(bad));
  assert.ok(isErr(run('SUMIF(mixed, ">=1", weight)', scoreScope)));

  // a criteria with no operand is an error, not a silent zero
  assert.ok(isErr(run('COUNTIF(score, ">=")', scoreScope)));

  // non-numeric operand compares as text, case-insensitively
  assert.equal(run('COUNTIF(label, ">=delta")', scoreScope), 3); // delta, epsilon, gamma
  assert.equal(run('COUNTIF(label, "<>beta")', scoreScope), 4);
});

test("SUMIF / COUNTIF plain criteria keep exact-match behaviour (SUB-743)", () => {
  // strings that don't start with a comparator are unchanged
  assert.equal(run('COUNTIF(bucket, "etf")', holdingsScope), 2);
  assert.equal(run('COUNTIF(label, "beta")', scoreScope), 1);
  // numeric and numeric-string matches still compare loosely-equal, not by range
  assert.equal(run("COUNTIF(score, 1)", scoreScope), 1);
  assert.equal(run('COUNTIF(score, "1")', scoreScope), 1);
  assert.equal(run("SUMIF(units, 80)", holdingsScope), 80);
  // a value column whose text merely contains a comparator is still exact-match
  const textScope: Scope = new Map([["note", ["a>b", ">=", "plain"]]]);
  assert.equal(run('COUNTIF(note, "a>b")', textScope), 1);
});

// SUB-744: row-wise products, summed — weighted averages without helper columns
const weightScope: Scope = new Map([
  ["value", [10, 20, 30]],
  ["weight", [1, 2, 7]],
  ["third", [2, 2, 2]],
  ["short", [1, 2]],
  ["texty", [10, "twenty", 30]],
  ["blanky", [10, null, 30]],
  ["wsonly", [10, "  ", 30]],
  ["loose_num", [10, "20", 30]],
  ["broken", [1, ferr("boom"), 3]],
]);

test("SUMPRODUCT: row-wise products summed (SUB-744)", () => {
  near(run("SUMPRODUCT(value, weight)", weightScope), 10 * 1 + 20 * 2 + 30 * 7);
  // three columns compose
  near(run("SUMPRODUCT(value, weight, third)", weightScope), 2 * (10 + 40 + 210));
  // single column behaves as SUM
  near(run("SUMPRODUCT(value)", weightScope), 60);
  assert.equal(run("SUMPRODUCT(value)", weightScope), run("SUM(value)", weightScope));
  // numeric strings coerce strictly, like everywhere else
  near(run("SUMPRODUCT(loose_num, weight)", weightScope), 10 + 40 + 210);
  // missing argument is an error
  assert.ok(isErr(run("SUMPRODUCT()")));
  // a scalar argument is not a column
  assert.ok(isErr(run("SUMPRODUCT(1 + 2)")));
});

test("SUMPRODUCT: mismatched column lengths are an error (SUB-744)", () => {
  const e = run("SUMPRODUCT(value, short)", weightScope);
  assert.ok(isErr(e) && /different lengths/.test(e.err), JSON.stringify(e));
  assert.ok(isErr(run("SUMPRODUCT(short, value)", weightScope)));
  assert.ok(isErr(run("SUMPRODUCT(value, weight, short)", weightScope)));
});

test("SUMPRODUCT: non-numeric rows contribute 0, error cells propagate (SUB-744)", () => {
  // text / blank / whitespace-only cells zero their row rather than skipping it
  near(run("SUMPRODUCT(texty, weight)", weightScope), 10 * 1 + 0 + 30 * 7);
  near(run("SUMPRODUCT(blanky, weight)", weightScope), 10 * 1 + 0 + 30 * 7);
  near(run("SUMPRODUCT(wsonly, weight)", weightScope), 10 * 1 + 0 + 30 * 7);
  // …which is what makes the weighted-average denominator honest: a blank
  // weight drops that row from both halves of the division
  const wa = run("SUMPRODUCT(value, blanky) / SUMPRODUCT(blanky)", weightScope);
  near(wa, (10 * 10 + 30 * 30) / (10 + 30));
  // an error cell in any argument propagates, in any position
  assert.ok(isErr(run("SUMPRODUCT(broken, weight)", weightScope)));
  assert.ok(isErr(run("SUMPRODUCT(weight, broken)", weightScope)));
  // …even when another column already zeroed that row
  assert.ok(isErr(run("SUMPRODUCT(blanky, broken)", weightScope)));
});

test("SUMPRODUCT: weighted average idiom (SUB-744)", () => {
  // €-weighted average price: SUMPRODUCT(v, w) / SUMPRODUCT(w)
  near(
    run("SUMPRODUCT(value, weight) / SUMPRODUCT(weight)", weightScope),
    (10 * 1 + 20 * 2 + 30 * 7) / 10
  );
  // over the real holdings columns, matching a hand-computed average
  const expected =
    (32863.128 * 1200 + 229502.56 * 4.1 + 6454.37 * 80) / (1200 + 4.1 + 80);
  near(run("SUMPRODUCT(value_eur, units) / SUMPRODUCT(units)", holdingsScope), expected, 1e-6);
});

// SUB-741: keyed lookup — one rates table instead of an inlined rate per row
const ratesScope: Scope = new Map([
  ["code", ["USD", "GBP", "CHF"]],
  ["rate", [0.8721, 1.1642, 1.0503]],
  ["year", [2024, 2025, 2026]],
  ["budget", [1000, 2000, 3000]],
  // computed column: budget doubled, materialized as a column like the engine does
  ["doubled", [2000, 4000, 6000]],
  ["dupe", ["a", "b", "a"]],
  ["dupeval", [1, 2, 3]],
  ["sparsekey", [null, "  ", "x"]],
  ["sparseval", [10, 20, 30]],
  ["gapval", ["", 5, 6]],
]);

test("LOOKUP: keyed row lookup (SUB-741)", () => {
  // 1. hit — string key and numeric key
  near(run('LOOKUP("USD", code, rate)', ratesScope), 0.8721);
  near(run("LOOKUP(2025, year, budget)", ratesScope), 2000);
  // key matching follows looseEq: case-insensitive text, numeric-string equality
  near(run('LOOKUP("usd", code, rate)', ratesScope), 0.8721);
  near(run('LOOKUP("2025", year, budget)', ratesScope), 2000);
  // 2. miss → error, never null/0 (a broken rates table can't zero out money math)
  const miss = run('LOOKUP("JPY", code, rate)', ratesScope);
  assert.ok(isErr(miss) && /no row where/.test(miss.err));
  // 3. value column may be computed
  near(run("LOOKUP(2026, year, doubled)", ratesScope), 6000);
  // 4. duplicate keys → first in stored row order (a data smell, not an error)
  assert.equal(run('LOOKUP("a", dupe, dupeval)', ratesScope), 1);
  // 6. blank key cells never match, and a blank key argument errors
  assert.equal(run('LOOKUP("x", sparsekey, sparseval)', ratesScope), 30);
  assert.ok(isErr(run('LOOKUP("", code, rate)', ratesScope)), "empty key errors");
  // a matched row with an empty value errors rather than reading as 0
  const empty = run("LOOKUP(2024, year, gapval)", ratesScope);
  assert.ok(isErr(empty) && /empty value/.test(empty.err));
  // composes with arithmetic, the flagship shape (price × rate)
  near(run('100 * LOOKUP("USD", code, rate)', ratesScope), 87.21);
  // argument shapes
  assert.ok(isErr(run('LOOKUP("USD", code)', ratesScope)), "needs three arguments");
  assert.ok(isErr(run('LOOKUP("USD", 1, rate)', ratesScope)), "key column must be a column");
  assert.ok(isErr(run('LOOKUP("USD", code, 1)', ratesScope)), "value column must be a column");
  assert.ok(isErr(run("LOOKUP(code, code, rate)", ratesScope)), "key must be a single value");
  // error cells propagate like every other aggregate
  const broken: Scope = new Map([
    ["k", ["a", ferr("boom")]],
    ["v", [1, 2]],
  ]);
  assert.ok(isErr(run('LOOKUP("zzz", k, v)', broken)));
});

test("LOOKUP: cross-sheet rates table (SUB-741)", () => {
  // 5. the flagship use — one Rates sheet, referenced from another sheet
  const scope: Scope = new Map<string, ScopedValue | ScopedValue[]>([
    ["rates.code", ["USD", "GBP"]],
    ["rates.rate", [0.8721, 1.1642]],
    ["price_usd", 250],
  ]);
  near(run('LOOKUP("USD", Rates.code, Rates.rate)', scope), 0.8721);
  near(run('price_usd * LOOKUP("USD", Rates.code, Rates.rate)', scope), 250 * 0.8721);
  assert.ok(isErr(run('LOOKUP("JPY", Rates.code, Rates.rate)', scope)));
});

// SUB-742: extra (column, match) pairs, ANDed
const multiScope: Scope = new Map([
  ["bucket", ["etf", "etf", "crypto", "crypto", "etf"]],
  ["net_worth", ["yes", "no", "yes", "yes", "yes"]],
  ["value", [100, 200, 400, 800, 1600]],
  ["score", [0, 5, 3, 5, 1]],
  ["short", [1, 2]],
]);

test("SUMIF / COUNTIF multi-criteria (SUB-742)", () => {
  // two criteria intersect (AND, not OR)
  assert.equal(run('COUNTIF(bucket, "etf", net_worth, "yes")', multiScope), 2);
  assert.equal(run('COUNTIF(bucket, "crypto", net_worth, "yes")', multiScope), 2);
  // OR would give 4 here; AND gives 2
  near(run('SUMIF(bucket, "etf", value, net_worth, "yes")', multiScope), 100 + 1600);
  near(run('SUMIF(bucket, "crypto", value, net_worth, "yes")', multiScope), 400 + 800);
  // three pairs
  assert.equal(run('COUNTIF(bucket, "etf", net_worth, "yes", score, 1)', multiScope), 1);
  near(run('SUMIF(bucket, "etf", value, net_worth, "yes", score, 1)', multiScope), 1600);
  // a pair that matches nothing gives 0, not a fallback to the first criteria
  assert.equal(run('COUNTIF(bucket, "etf", net_worth, "maybe")', multiScope), 0);
  near(run('SUMIF(bucket, "etf", value, net_worth, "maybe")', multiScope), 0);

  // each added match still honours ">=1"-style comparison criteria (SUB-743)
  assert.equal(run('COUNTIF(bucket, "etf", score, ">=1")', multiScope), 2); // 5, 1
  assert.equal(run('COUNTIF(bucket, "etf", score, ">1")', multiScope), 1); // 5
  assert.equal(run('COUNTIF(score, ">=1", net_worth, "yes")', multiScope), 3); // 3, 5, 1
  near(run('SUMIF(bucket, "etf", value, score, ">=1")', multiScope), 200 + 1600);
  near(run('SUMIF(score, ">=1", value, net_worth, "yes")', multiScope), 400 + 800 + 1600);
  assert.equal(run('COUNTIF(bucket, "<>crypto", net_worth, "<>no")', multiScope), 2);

  // criteria over computed columns — they are just scope columns
  const computed: Scope = new Map([
    ["qty", [1, 2, 3, 4]],
    ["price", [10, 10, 20, 20]],
    ["bucket", ["a", "b", "a", "b"]],
  ]);
  // total = qty * price → 10, 20, 60, 80 (computed inline, same shape as a
  // computed column feeding a summary)
  const withComputed: Scope = new Map(computed);
  withComputed.set("total", [10, 20, 60, 80]);
  assert.equal(run('COUNTIF(total, ">=20", bucket, "b")', withComputed), 2);
  near(run('SUMIF(total, ">=20", qty, bucket, "b")', withComputed), 2 + 4);
  assert.equal(run('COUNTIF(bucket, "a", total, ">50")', withComputed), 1);

  // zero criteria errors
  assert.ok(isErr(run("COUNTIF(bucket)", multiScope)));
  assert.ok(isErr(run("SUMIF(value)", multiScope)));
  assert.ok(isErr(run("COUNTIF()", multiScope)));

  // an unpaired trailing column is an arity error, not a silent drop
  const unpaired = run('COUNTIF(bucket, "etf", net_worth)', multiScope);
  assert.ok(isErr(unpaired) && /pairs/.test(unpaired.err), JSON.stringify(unpaired));
  const unpairedSum = run('SUMIF(bucket, "etf", value, net_worth)', multiScope);
  assert.ok(isErr(unpairedSum) && /pairs/.test(unpairedSum.err), JSON.stringify(unpairedSum));
  // SUMIF's extended form must spell the value column: an odd tail is an error
  assert.ok(isErr(run('SUMIF(bucket, "etf", net_worth, "yes", score)', multiScope)));

  // mismatched criteria-column lengths error rather than truncating silently
  const mismatch = run('COUNTIF(bucket, "etf", short, 1)', multiScope);
  assert.ok(isErr(mismatch) && /same number of rows/.test(mismatch.err), JSON.stringify(mismatch));
  assert.ok(isErr(run('SUMIF(bucket, "etf", value, short, 1)', multiScope)));

  // a scalar where a criteria column belongs is still a column error
  assert.ok(isErr(run('COUNTIF(bucket, "etf", 1 + 2, 3)', multiScope)));
});

// ---- SUB-752: wildcard criteria in SUMIF/COUNTIF (start) ----
const wildScope: Scope = new Map([
  ["type", ["ETF x", "ETF y", "Stock", "etf z"]],
  ["amount", [1, 2, 4, 8]],
  ["code", ["ab", "axb", "aXXb", "a*b", "a?b", "a~b"]],
  ["blanky", ["ETF a", null, "", "   ", "ETF b"]],
  ["region", ["EU", "US", "EU", "EU"]],
]);

test("SUMIF / COUNTIF wildcard criteria (SUB-752)", () => {
  // `*` — any run, including empty; case-insensitive like every other match
  assert.equal(run('COUNTIF(type, "ETF*")', wildScope), 3);
  assert.equal(run('COUNTIF(type, "etf*")', wildScope), 3);
  assert.equal(run('COUNTIF(type, "*x")', wildScope), 1);
  assert.equal(run('COUNTIF(type, "*")', wildScope), 4);
  assert.equal(run('COUNTIF(code, "a*b")', wildScope), 6); // every code cell: a…b
  near(run('SUMIF(type, "ETF*", amount)', wildScope), 1 + 2 + 8);
  near(run('SUMIF(type, "ETF*")', wildScope), 0); // criteria column is text

  // `?` — exactly one character, never zero, never two
  assert.equal(run('COUNTIF(code, "a?b")', wildScope), 4); // axb, a*b, a?b, a~b — not ab, not aXXb
  assert.equal(run('COUNTIF(code, "a??b")', wildScope), 1); // aXXb only

  // Excel escapes: ~* ~? ~~ are the literal characters
  assert.equal(run('COUNTIF(code, "a~*b")', wildScope), 1);
  assert.equal(run('COUNTIF(code, "a~?b")', wildScope), 1);
  assert.equal(run('COUNTIF(code, "a~~b")', wildScope), 1); // ~~ = one literal tilde → a~b
  assert.equal(run('COUNTIF(code, "a~~*")', wildScope), 1); // literal tilde, then wildcard → a~b
  // `~*` is a literal star all the way: "a~*" matches the string "a*", nothing here
  assert.equal(run('COUNTIF(code, "a~*")', wildScope), 0);

  // blank cells never match, not even "*" (SUB-238 doctrine)
  assert.equal(run('COUNTIF(blanky, "*")', wildScope), 2);
  assert.equal(run('COUNTIF(blanky, "ETF*")', wildScope), 2);

  // multi-criteria pairs get identical treatment (SUB-742 seam)
  assert.equal(run('COUNTIF(type, "ETF*", region, "EU")', wildScope), 2);
  assert.equal(run('COUNTIF(region, "EU", type, "ETF*")', wildScope), 2);
  near(run('SUMIF(type, "ETF*", amount, region, "EU")', wildScope), 1 + 8);
});

test("SUMIF / COUNTIF matches without wildcards are unchanged (SUB-752)", () => {
  // plain strings, numbers and comparison criteria all keep today's behaviour
  assert.equal(run('COUNTIF(type, "Stock")', wildScope), 1);
  assert.equal(run('COUNTIF(type, "ETF")', wildScope), 0);
  assert.equal(run('COUNTIF(code, "ab")', wildScope), 1);
  assert.equal(run('COUNTIF(bucket, "etf")', multiScope), 3);
  assert.equal(run("COUNTIF(score, 1)", multiScope), 1);
  assert.equal(run('COUNTIF(score, ">=1")', multiScope), 4);
  // a `*`-shaped comparison operand still parses as a comparison, not a pattern
  assert.equal(run('COUNTIF(type, "<>ETF x")', wildScope), 3);
});
// ---- SUB-752: wildcard criteria in SUMIF/COUNTIF (end) ----

test("SUMIF / COUNTIF single-criterion forms are unchanged (SUB-742)", () => {
  assert.equal(run('COUNTIF(bucket, "etf")', multiScope), 3);
  near(run('SUMIF(bucket, "etf", value)', multiScope), 100 + 200 + 1600);
  near(run('SUMIF(score, ">=1")', multiScope), 5 + 3 + 5 + 1);
  // error cells: COUNTIF skips them, SUMIF propagates
  const broken: Scope = new Map([
    ["k", ["a", ferr("boom"), "a"]],
    ["v", [1, 2, 3]],
  ]);
  assert.equal(run('COUNTIF(k, "a")', broken), 2);
  assert.ok(isErr(run('SUMIF(k, "a", v)', broken)));
});

test("aggregate results compose with arithmetic", () => {
  near(run("SUM(value_eur) - SUMIF(bucket, \"crypto\", value_eur)", holdingsScope), 32863.128 + 6454.37);
});

test("row scope: refs resolve per-row, empty is 0, numeric strings coerce", () => {
  const row: Scope = new Map([
    ["units", 1200], // plain scalar in row scope
    ["price_usd", 31.4],
    ["note", null],
  ]);
  near(run("units * price_usd", row), 37680);
  assert.equal(run("note + 5", row), 5);
  const strRow: Scope = new Map([["n", "12"]]);
  assert.equal(run("n * 2", strRow), 24);
});

test("errors: unknown column, column as scalar, scalar as column, unknown fn", () => {
  assert.ok(isErr(run("nope * 2", new Map())));
  assert.ok(isErr(run("units + 1", holdingsScope)), "whole column in scalar op");
  assert.ok(isErr(run("SUM(1 + 2)", holdingsScope)), "scalar as aggregate column");
  assert.ok(isErr(run("WAT(1)")));
});

test("errors carry messages and propagate", () => {
  const v = run("1 + nope");
  assert.ok(isErr(v));
  assert.match((v as { err: string }).err, /unknown column/);
  assert.deepEqual(ferr("x"), { err: "x" });
});

test("syntax errors are reported, not thrown", () => {
  for (const bad of ["", "1 +", "1 2", "SUM(", "(1", "1 < 2 < 3", '"open']) {
    const expr = parseFormula(bad);
    assert.ok(isErr(expr), `expected error for ${JSON.stringify(bad)}`);
  }
});

test("hasAggregate classifies computed columns vs summaries", () => {
  const colExpr = parseFormula("units * price_usd");
  const sumExpr = parseFormula("SUM(value_eur) * 2");
  assert.ok(!isErr(colExpr) && !hasAggregate(colExpr));
  assert.ok(!isErr(sumExpr) && hasAggregate(sumExpr));
});

test("hasAggregate: a row-shaped LOOKUP key keeps the line per-row (SUB-748)", () => {
  // `rowShaped` is what sheet.ts passes: a bare ref that isn't a summary name.
  const cols = (...names: string[]) => (r: string) => names.includes(r);
  const parse = (src: string) => {
    const e = parseFormula(src);
    assert.ok(!isErr(e), src);
    return e;
  };
  const rowKey = parse("price_usd * LOOKUP(currency, Rates.code, Rates.rate)");
  const constKey = parse('LOOKUP("USD", Rates.code, Rates.rate)');
  const cols3 = cols("price_usd", "currency");
  // the row-shaped KEY flips classification; the table columns never do
  assert.ok(!hasAggregate(rowKey, cols3), "row-shaped key → computed column");
  assert.ok(hasAggregate(constKey, cols3), "constant key → summary");
  // a key that is a summary name (not row-shaped) stays summary-class
  assert.ok(hasAggregate(parse("LOOKUP(base, Rates.code, Rates.rate)"), cols3));
  // opting out (no predicate) keeps the pre-SUB-748 rule: every LOOKUP aggregates
  assert.ok(hasAggregate(rowKey), "without rowShaped, LOOKUP is aggregate-class");
  // a real aggregate anywhere else on the line still makes it a summary
  assert.ok(hasAggregate(parse("SUM(price_usd) * LOOKUP(currency, Rates.code, Rates.rate)"), cols3));
  // ...including inside the row-scoped LOOKUP's own key
  assert.ok(hasAggregate(parse("LOOKUP(MAX(currency), Rates.code, Rates.rate)"), cols3));
  // a local (same-sheet) table is fine too — only the key argument is row-read
  assert.ok(!hasAggregate(parse("LOOKUP(currency, code, rate)"), cols("currency", "code", "rate")));
  // LOOKUP keyed off a row-scoped LOOKUP stays one per-row line
  assert.ok(
    !hasAggregate(parse("LOOKUP(LOOKUP(currency, A.k, A.v), B.k, B.v)"), cols3),
    "nested row-scoped LOOKUP stays per-row"
  );
});

test("function and column names are case-insensitive", () => {
  assert.equal(run("sum(units)", holdingsScope), 1284.1);
  assert.equal(run("Sum(UNITS)", holdingsScope), 1284.1);
  const row: Scope = new Map([["units", 3]]);
  assert.equal(run("UNITS * 2", row), 6);
});

test("cross-sheet refs parse dotted and quoted, resolve from scope", () => {
  const scope: Scope = new Map<string, ScopedValue | ScopedValue[]>([
    ["holdings.total", 1000],
    ["holdings.value_eur", [10, 20]],
    ["portfolio tracker.cash_total", 50],
  ]);
  assert.equal(run("Holdings.total", scope), 1000);
  assert.equal(run("holdings.TOTAL + 1", scope), 1001);
  assert.equal(run("SUM(Holdings.value_eur)", scope), 30);
  assert.equal(run('"Portfolio Tracker".cash_total * 2', scope), 100);
  // member name is required after the dot
  assert.ok(isErr(parseFormula("Holdings.")));
  assert.ok(isErr(parseFormula("Holdings.123")));
  // a second dot is trailing input
  assert.ok(isErr(parseFormula("a.b.c")));
  // missing binding is a scoped error, not a crash
  assert.ok(isErr(run("Nope.total", scope)));
});

test("collectRefs reports cross-sheet refs dotted, collectCrossRefs splits them", () => {
  const e = parseFormula('SUM(Holdings.value_eur) + local + "My Sheet".x');
  assert.ok(!isErr(e));
  assert.deepEqual(collectRefs(e), ["holdings.value_eur", "local", "my sheet.x"]);
  assert.deepEqual(collectCrossRefs(e), [
    { sheet: "holdings", name: "value_eur" },
    { sheet: "my sheet", name: "x" },
  ]);
});

test("renameRefs rewrites idents, keeps strings/calls/dotted members/formatting", () => {
  assert.equal(renameRefs("total - crypto", "total", "net"), "net - crypto");
  assert.equal(renameRefs("SUM(value_eur)  +  TOTAL", "total", "net"), "SUM(value_eur)  +  net");
  // string literal mentioning the name stays
  assert.equal(renameRefs('SUMIF(bucket, "crypto", value_eur)', "crypto", "btc"), 'SUMIF(bucket, "crypto", value_eur)');
  // function names are not refs
  assert.equal(renameRefs("SUM(total)", "sum", "add"), "SUM(total)");
  // other sheets' members and sheet names stay
  assert.equal(renameRefs("Holdings.total + total", "total", "net"), "Holdings.total + net");
  assert.equal(renameRefs("total.total", "total", "net"), "total.total");
  // unparsable source comes back unchanged
  assert.equal(renameRefs("1 +", "total", "net"), "1 +");
});

// ---------- SUB-753: unicode identifiers ----------

describe("SUB-753 unicode identifiers", () => {
  const scope = (o: Record<string, Value>): Scope => new Map(Object.entries(o));

  test("umlaut column resolves and computes", () => {
    const e = parseFormula("Größe * 2");
    assert.ok(!isErr(e));
    assert.deepEqual(collectRefs(e), ["größe"]);
    assert.equal(evaluate(e, scope({ größe: 21 }), fx), 42);
  });

  test("CJK column resolves and computes", () => {
    const e = parseFormula("价格 + 1");
    assert.ok(!isErr(e));
    assert.deepEqual(collectRefs(e), ["价格"]);
    assert.equal(evaluate(e, scope({ 价格: 9 }), fx), 10);
  });

  test("scope folding is case-insensitive across umlauts", () => {
    const upper = parseFormula("Größe");
    const lower = parseFormula("größe");
    assert.ok(!isErr(upper) && !isErr(lower));
    assert.deepEqual(collectRefs(upper), collectRefs(lower));
    assert.equal(evaluate(upper, scope({ größe: 7 }), fx), 7);
    assert.equal(evaluate(lower, scope({ größe: 7 }), fx), 7);
  });

  test("unicode member after a quoted sheet name, and digits inside a name", () => {
    const e = parseFormula('SUM("März Rates".größe_2024)');
    assert.ok(!isErr(e));
    assert.deepEqual(collectRefs(e), ["märz rates.größe_2024"]);
  });

  test("renameRefs rewrites unicode idents and respects the same exclusions", () => {
    assert.equal(renameRefs("Größe * 2", "größe", "breite"), "breite * 2");
    assert.equal(renameRefs("größe + Größe", "Größe", "höhe"), "höhe + höhe");
    assert.equal(renameRefs("价格 - kosten", "价格", "preis"), "preis - kosten");
    // dotted members and string literals stay untouched
    assert.equal(renameRefs("Lager.größe + größe", "größe", "breite"), "Lager.größe + breite");
    assert.equal(renameRefs('SUMIF(art, "größe", x)', "größe", "breite"), 'SUMIF(art, "größe", x)');
  });

  test("digits still cannot start an identifier", () => {
    const e = parseFormula("2024 * 2");
    assert.ok(!isErr(e));
    assert.equal(evaluate(e, scope({}), fx), 4048);
  });
});
