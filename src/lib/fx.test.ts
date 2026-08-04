import test from "node:test";
import assert from "node:assert/strict";
import {
  MOCK_FX,
  MOCK_FX_RATES,
  makeFxResolver,
  parseFxCache,
  parseFxRatesCache,
  serializeFxCache,
  serializeFxRatesCache,
  usdEurFrom,
  type FxRatesState,
} from "./fx.ts";

test("parseFxCache: round-trips a serialized rate", () => {
  const raw = serializeFxCache({ usdEur: 0.8778, asOf: "2026-07-23" });
  assert.deepEqual(parseFxCache(raw), { usdEur: 0.8778, asOf: "2026-07-23", live: false });
});

test("parseFxCache: rejects junk — null, malformed json, bad numbers", () => {
  assert.equal(parseFxCache(null), null);
  assert.equal(parseFxCache(""), null);
  assert.equal(parseFxCache("not json"), null);
  assert.equal(parseFxCache('{"usdEur":"0.87"}'), null);
  assert.equal(parseFxCache('{"usdEur":0}'), null);
  assert.equal(parseFxCache('{"usdEur":-1,"asOf":"x"}'), null);
});

test("parseFxCache: missing asOf degrades to empty string", () => {
  assert.deepEqual(parseFxCache('{"usdEur":0.9}'), { usdEur: 0.9, asOf: "", live: false });
});

/* ---- rate table (SUB-834) ------------------------------------------- */

// EUR base, the shape the engine hands over: 1 EUR buys 1.164 USD.
const table: FxRatesState = {
  base: "EUR",
  rates: { USD: 1.164, GBP: 0.86445, JPY: 171.24 },
  asOf: "2026-08-01",
  live: true,
};

const near = (v: number | null, expected: number, eps = 1e-12) => {
  assert.ok(v !== null, "expected a rate, got null");
  assert.ok(Math.abs(v - expected) < eps, `${v} !== ${expected}`);
};

test("parseFxRatesCache: round-trips a serialized table", () => {
  const raw = serializeFxRatesCache(table);
  assert.deepEqual(parseFxRatesCache(raw), { ...table, live: false });
});

test("parseFxRatesCache: rejects junk — null, malformed json, no usable row", () => {
  assert.equal(parseFxRatesCache(null), null);
  assert.equal(parseFxRatesCache(""), null);
  assert.equal(parseFxRatesCache("not json"), null);
  assert.equal(parseFxRatesCache('{"rates":{"USD":1.1}}'), null); // no base
  assert.equal(parseFxRatesCache('{"base":"EUR"}'), null); // no rates
  assert.equal(parseFxRatesCache('{"base":"EUR","rates":{}}'), null);
  assert.equal(parseFxRatesCache('{"base":"EUR","rates":{"USD":"1.1"}}'), null);
});

test("parseFxRatesCache: drops bad rows, uppercases codes, degrades a missing asOf", () => {
  const p = parseFxRatesCache('{"base":"eur","rates":{"usd":1.164,"gbp":0,"jpy":-1,"chf":"x"}}');
  assert.deepEqual(p, { base: "EUR", rates: { USD: 1.164 }, asOf: "", live: false });
});

test("makeFxResolver: converts any pair through the base", () => {
  const fx = makeFxResolver(table);
  // base on one side is a straight table read either way
  near(fx("EUR", "USD"), 1.164);
  near(fx("USD", "EUR"), 1 / 1.164);
  // a cross rate goes from→EUR→to
  near(fx("USD", "GBP"), 0.86445 / 1.164);
  near(fx("GBP", "JPY"), 171.24 / 0.86445);
  // and it round-trips
  near(fx("JPY", "GBP")! * fx("GBP", "JPY")!, 1);
});

test("makeFxResolver: identity is 1, unknown codes are null", () => {
  const fx = makeFxResolver(table);
  assert.equal(fx("USD", "USD"), 1);
  assert.equal(fx("EUR", "EUR"), 1);
  // even a currency the table never quoted converts to itself
  assert.equal(fx("XAU", "XAU"), 1);
  assert.equal(fx("USD", "XAU"), null);
  assert.equal(fx("XAU", "USD"), null);
  assert.equal(fx("XAU", "XPD"), null);
  // no table at all — the pre-refresh state — quotes nothing
  assert.equal(makeFxResolver(null)("USD", "EUR"), null);
});

test("makeFxResolver: codes are case-insensitive", () => {
  const fx = makeFxResolver(table);
  near(fx("usd", "eur"), 1 / 1.164);
  near(fx("Usd", "gBp"), 0.86445 / 1.164);
});

test("usdEurFrom: derives the single pair the older surfaces read", () => {
  assert.deepEqual(usdEurFrom(table), { usdEur: 1 / 1.164, asOf: "2026-08-01", live: true });
  assert.equal(usdEurFrom(null), null);
  // a table that can't quote USD reports nothing rather than a wrong figure
  assert.equal(usdEurFrom({ base: "EUR", rates: { GBP: 0.86 }, asOf: "", live: false }), null);
});

test("the mock table quotes USD→EUR at the mock single rate", () => {
  // 0.8721 has no exact reciprocal in a double, so the table's derived rate
  // can only land within an ULP — never bit-identical
  const rate = makeFxResolver(MOCK_FX_RATES)("USD", "EUR")!;
  assert.ok(Math.abs(rate - MOCK_FX.usdEur) <= Number.EPSILON * MOCK_FX.usdEur, String(rate));
  assert.equal(usdEurFrom(MOCK_FX_RATES)!.asOf, MOCK_FX.asOf);
});

test("the mock table renders the Holdings fixture exactly as the single rate did", () => {
  // what actually has to hold: e2e baselines are RENDERED figures, and a
  // one-ULP drift in the mock USD literal moves value_eur on the 9×3050 row
  // by a cent. This is the guard on that literal (see MOCK_FX_RATES).
  const rate = makeFxResolver(MOCK_FX_RATES)("USD", "EUR")!;
  const eur = (v: number) =>
    v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // the mock Holdings sheet: units × price_usd, per row and summed
  const usd = [1200 * 31.4, 4.1 * 64200, 80 * 92.5, 9 * 3050];
  for (const v of usd) assert.equal(eur(v * rate), eur(v * MOCK_FX.usdEur), `row ${v}`);
  const sum = (r: number) => usd.reduce((s, v) => s + v * r, 0);
  assert.equal(eur(sum(rate)), eur(sum(MOCK_FX.usdEur)));
});
