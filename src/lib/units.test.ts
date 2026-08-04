import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  formatQuantity,
  parseQuantity,
  resolveUnit,
  sameDimension,
} from "./units.ts";
import { isErr } from "./formula.ts";
import type { FxResolver } from "./formula.ts";

// USD→EUR only; every other pair is "no rate", which is what the error paths
// below exercise.
const fx: FxResolver = (from, to) => (from === "USD" && to === "EUR" ? 0.9 : null);
const noFx: FxResolver = () => null;

const errText = (v: unknown): string => {
  assert.ok(isErr(v), `expected an error value, got ${JSON.stringify(v)}`);
  return v.err;
};

// ---------- resolveUnit ----------

test("resolveUnit matches codes case-insensitively", () => {
  assert.equal(resolveUnit("kg")?.code, "kg");
  assert.equal(resolveUnit("KG")?.code, "kg");
  assert.equal(resolveUnit("bpm")?.code, "BPM");
  assert.equal(resolveUnit("Lufs")?.code, "LUFS");
  assert.equal(resolveUnit("db")?.code, "dB");
  assert.equal(resolveUnit("eur")?.code, "EUR");
  assert.equal(resolveUnit(" usd ")?.code, "USD");
});

test("resolveUnit matches aliases and symbols", () => {
  assert.equal(resolveUnit("€")?.code, "EUR");
  assert.equal(resolveUnit("euro")?.code, "EUR");
  assert.equal(resolveUnit("Euros")?.code, "EUR");
  assert.equal(resolveUnit("$")?.code, "USD");
  assert.equal(resolveUnit("£")?.code, "GBP");
  assert.equal(resolveUnit("¥")?.code, "JPY");
  assert.equal(resolveUnit("kilos")?.code, "kg");
  assert.equal(resolveUnit("miles")?.code, "mi");
  assert.equal(resolveUnit("minutes")?.code, "min");
  assert.equal(resolveUnit("inches")?.code, "inch");
});

test("resolveUnit: “m” is the metre and “in” is not the inch", () => {
  // "m" must never be the minute — that would make every length column
  // ambiguous. The minute is "min".
  assert.equal(resolveUnit("m")?.code, "m");
  assert.equal(resolveUnit("m")?.dimension, "length");
  assert.equal(resolveUnit("min")?.dimension, "time");
  // "in" stays reserved as the calc-line conversion keyword.
  assert.equal(resolveUnit("in"), undefined);
  assert.equal(resolveUnit("inch")?.code, "inch");
});

test("resolveUnit returns undefined for unknown tokens", () => {
  assert.equal(resolveUnit("furlongs"), undefined);
  assert.equal(resolveUnit(""), undefined);
  assert.equal(resolveUnit("°C"), undefined); // affine, deliberately absent
});

// ---------- parseQuantity ----------

test("parseQuantity reads a plain number as a unit-less quantity", () => {
  assert.deepEqual(parseQuantity("42"), { value: 42, unit: null });
  assert.deepEqual(parseQuantity("  -3.5 "), { value: -3.5, unit: null });
  assert.deepEqual(parseQuantity("+7"), { value: 7, unit: null });
});

test("parseQuantity reads a trailing word unit, spaced or glued", () => {
  assert.deepEqual(parseQuantity("25 USD"), { value: 25, unit: "USD" });
  assert.deepEqual(parseQuantity("25USD"), { value: 25, unit: "USD" });
  assert.deepEqual(parseQuantity("5 kg"), { value: 5, unit: "kg" });
  assert.deepEqual(parseQuantity("5kg"), { value: 5, unit: "kg" });
  assert.deepEqual(parseQuantity("128 BPM"), { value: 128, unit: "BPM" });
  assert.deepEqual(parseQuantity("-14 LUFS"), { value: -14, unit: "LUFS" });
  assert.deepEqual(parseQuantity("2.5 kilos"), { value: 2.5, unit: "kg" });
});

test("parseQuantity reads a symbol unit as prefix or suffix", () => {
  assert.deepEqual(parseQuantity("$25"), { value: 25, unit: "USD" });
  assert.deepEqual(parseQuantity("$ 25"), { value: 25, unit: "USD" });
  assert.deepEqual(parseQuantity("25 €"), { value: 25, unit: "EUR" });
  assert.deepEqual(parseQuantity("25€"), { value: 25, unit: "EUR" });
  assert.deepEqual(parseQuantity("£19.99"), { value: 19.99, unit: "GBP" });
});

test("parseQuantity keeps the sign in front of a symbol prefix", () => {
  assert.deepEqual(parseQuantity("-€1.234,56"), { value: -1234.56, unit: "EUR" });
  assert.deepEqual(parseQuantity("-$5"), { value: -5, unit: "USD" });
});

test("parseQuantity reads German-typed numbers through normalizeNumberInput", () => {
  assert.deepEqual(parseQuantity("1.234,56 €"), { value: 1234.56, unit: "EUR" });
  assert.deepEqual(parseQuantity("1.234 kg"), { value: 1234, unit: "kg" });
  assert.deepEqual(parseQuantity("12,5 kg"), { value: 12.5, unit: "kg" });
  // en-style decimals keep working
  assert.deepEqual(parseQuantity("1234.56 EUR"), { value: 1234.56, unit: "EUR" });
});

test("parseQuantity returns null for anything that isn't a quantity", () => {
  assert.equal(parseQuantity("kg"), null); // a unit with no number
  assert.equal(parseQuantity(""), null);
  assert.equal(parseQuantity("   "), null);
  assert.equal(parseQuantity("hello"), null);
  assert.equal(parseQuantity("2026-08-03"), null);
  // An unknown trailing unit is null, NOT a bare 25: silently dropping the
  // unit would turn "25 furlongs" into money-shaped nonsense.
  assert.equal(parseQuantity("25 furlongs"), null);
  assert.equal(parseQuantity("5 in"), null); // "in" is the conversion keyword
  assert.equal(parseQuantity("$25 kg"), null); // two units, no honest reading
  assert.equal(parseQuantity("1e3"), null); // parseStrictNumber rejects exponents
  assert.equal(parseQuantity("Infinity"), null);
});

// ---------- convert ----------

test("convert scales within a dimension by static factors", () => {
  assert.equal(convert({ value: 2, unit: "kg" }, "g", noFx), 2000);
  assert.equal(convert({ value: 500, unit: "g" }, "kg", noFx), 0.5);
  assert.equal(convert({ value: 1, unit: "t" }, "kg", noFx), 1000);
  assert.equal(convert({ value: 250, unit: "ms" }, "s", noFx), 0.25);
  assert.equal(convert({ value: 90, unit: "min" }, "h", noFx), 1.5);
  assert.equal(convert({ value: 2, unit: "KB" }, "B", noFx), 2048);
  assert.equal(convert({ value: 1, unit: "GB" }, "MB", noFx), 1024);
  // 12 inch is exactly 1 ft by definition, but 12 × 0.0254 / 0.3048 lands a
  // double ulp short — factor math is approximate, callers round for display.
  const ft = convert({ value: 12, unit: "inch" }, "ft", noFx);
  assert.ok(!isErr(ft));
  assert.ok(Math.abs((ft as number) - 1) < 1e-12);
});

test("convert round-trips km→mi→km", () => {
  const mi = convert({ value: 42.195, unit: "km" }, "mi", noFx);
  assert.ok(!isErr(mi));
  assert.ok(Math.abs((mi as number) - 26.2187) < 0.001);
  const back = convert({ value: mi as number, unit: "mi" }, "km", noFx);
  assert.ok(!isErr(back));
  assert.ok(Math.abs((back as number) - 42.195) < 1e-9);
});

test("convert to the same unit is the identity", () => {
  assert.equal(convert({ value: 7.5, unit: "kg" }, "kg", noFx), 7.5);
  assert.equal(convert({ value: 128, unit: "BPM" }, "bpm", noFx), 128);
  assert.equal(convert({ value: 5, unit: "EUR" }, "€", noFx), 5);
});

test("convert routes currency through the FX resolver", () => {
  assert.equal(convert({ value: 100, unit: "USD" }, "EUR", fx), 90);
  assert.equal(convert({ value: 100, unit: "$" }, "€", fx), 90);
});

test("convert errors when the FX resolver has no rate", () => {
  const e = errText(convert({ value: 100, unit: "EUR" }, "USD", fx));
  assert.match(e, /EUR/);
  assert.match(e, /USD/);
  assert.match(errText(convert({ value: 1, unit: "GBP" }, "CHF", noFx)), /GBP→CHF/);
});

test("convert refuses display-only units", () => {
  assert.match(errText(convert({ value: 128, unit: "BPM" }, "kg", noFx)), /BPM.*kg/);
  assert.match(errText(convert({ value: 128, unit: "BPM" }, "LUFS", noFx)), /BPM.*LUFS/);
  assert.match(errText(convert({ value: 50, unit: "%" }, "dB", noFx)), /%.*dB/);
});

test("convert refuses cross-dimension and unknown asks", () => {
  assert.match(errText(convert({ value: 5, unit: "kg" }, "m", noFx)), /kg.*m/);
  assert.match(errText(convert({ value: 5, unit: "kg" }, "EUR", noFx)), /kg.*EUR/);
  assert.match(errText(convert({ value: 5, unit: "EUR" }, "kg", noFx)), /EUR.*kg/);
  assert.match(errText(convert({ value: 5, unit: "furlong" }, "m", noFx)), /furlong/);
  assert.match(errText(convert({ value: 5, unit: "kg" }, "furlong", noFx)), /furlong/);
});

test("convert errors on a unit-less quantity", () => {
  assert.match(errText(convert({ value: 5, unit: null }, "kg", noFx)), /no unit/);
});

// ---------- sameDimension ----------

test("sameDimension groups convertible units and separates the rest", () => {
  assert.equal(sameDimension("kg", "g"), true);
  assert.equal(sameDimension("KG", "lb"), true);
  assert.equal(sameDimension("EUR", "usd"), true);
  assert.equal(sameDimension("km", "inch"), true);
  assert.equal(sameDimension("kg", "m"), false);
  assert.equal(sameDimension("EUR", "kg"), false);
  assert.equal(sameDimension("KB", "s"), false);
  // display-only units are only ever themselves
  assert.equal(sameDimension("BPM", "BPM"), true);
  assert.equal(sameDimension("BPM", "LUFS"), false);
  assert.equal(sameDimension("%", "dB"), false);
  assert.equal(sameDimension("kg", "furlong"), false);
});

// ---------- formatQuantity ----------

test("formatQuantity renders the de-DE dialect with the unit suffix", () => {
  assert.equal(formatQuantity(1234.56, "EUR", "de"), "1.234,56 €");
  assert.equal(formatQuantity(1234.56, "kg", "de"), "1.234,56 kg");
  assert.equal(formatQuantity(128, "BPM", "de"), "128 BPM");
  assert.equal(formatQuantity(-14.2, "LUFS", "de"), "-14,2 LUFS");
  assert.equal(formatQuantity(50, "%", "de"), "50 %");
});

test("formatQuantity renders the intl dialect", () => {
  assert.equal(formatQuantity(1234.56, "EUR", "intl"), "1,234.56 €");
  assert.equal(formatQuantity(1234.56, "kg", "intl"), "1,234.56 kg");
  assert.equal(formatQuantity(1000000, null, "intl"), "1,000,000");
});

test("formatQuantity leaves a unit-less number bare", () => {
  assert.equal(formatQuantity(1234.5, null, "de"), "1.234,5");
  assert.equal(formatQuantity(42, null, "de"), "42");
});

test("formatQuantity pre-rounds float noise and normalizes -0", () => {
  assert.equal(formatQuantity(0.1 + 0.2, null, "de"), "0,3");
  assert.equal(formatQuantity(-0, "kg", "de"), "0 kg");
  assert.equal(formatQuantity(-0.001, "kg", "de"), "0 kg");
  assert.equal(formatQuantity(2.005, null, "intl"), "2.01");
});

test("formatQuantity spells out a unit it doesn't know rather than dropping it", () => {
  assert.equal(formatQuantity(5, "furlong", "de"), "5 furlong");
});
