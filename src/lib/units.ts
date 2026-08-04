// Unit registry and quantity layer (SUB-834) — the shared vocabulary behind
// calc lines ("25 USD in EUR") and unit-aware columns.
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.
// Keep to erasable TS syntax only (no enums/namespaces) so node can strip types.
//
// Only LINEAR units live here. Temperature is deliberately absent: °C→°F is
// affine (× 9/5 + 32), not a single factor, so it can't ride the `factor`
// model without lying about the offset. It needs its own converter if it ever
// lands.

import { normalizeNumberInput, parseStrictNumber } from "./aggregate.ts";
import { ferr, type FErr, type FxResolver } from "./formula.ts";

export interface UnitDef {
  /** Canonical code, as stored and as `Quantity.unit` carries it. */
  code: string;
  /** "currency" | "mass" | "length" | "time" | "data" | "none". */
  dimension: string;
  /** Multiplier to the dimension's base unit. 1 for currency (FX does the
      work) and for "none" (display-only units never convert). */
  factor: number;
  /** Lowercase match forms. The code's own lowercasing is added automatically,
      so codes match case-insensitively too ("bpm" → BPM, "kb" → KB). */
  aliases: string[];
  /** Display form appended after a formatted number, leading space included. */
  suffix: string;
}

/** A number that knows what it is. `unit` is a canonical code, or null for a
    plain number (which never converts). */
export interface Quantity {
  value: number;
  unit: string | null;
}

// ---------- registry ----------

// Currency factors are all 1: rates are a runtime concern (FxResolver), not a
// static table. The symbol aliases are the ones that may also *prefix* a
// number ("$25"), see SYMBOL_PREFIX_RE.
//
// Alias collisions worth naming, since the index rejects duplicates outright:
//   "pound"/"pounds" → GBP, never the mass unit lb (lb answers to "lb"/"lbs").
//   "$" → USD, not CAD/AUD; those need their codes spelled out.
//   "m" → metre. The minute is "min" — a bare "m" for minutes would make
//   every length column ambiguous.
//   "in" is NOT an alias for the inch: calc lines reserve it as the conversion
//   keyword ("5 kg in lb"). The inch answers to "inch"/"inches" only.
const UNITS: UnitDef[] = [
  // currency — factor 1, conversion goes through the FxResolver
  { code: "EUR", dimension: "currency", factor: 1, aliases: ["€", "euro", "euros"], suffix: " €" },
  {
    code: "USD",
    dimension: "currency",
    factor: 1,
    aliases: ["$", "dollar", "dollars"],
    suffix: " $",
  },
  { code: "GBP", dimension: "currency", factor: 1, aliases: ["£", "pound", "pounds"], suffix: " £" },
  { code: "CHF", dimension: "currency", factor: 1, aliases: ["franken", "franc", "francs"], suffix: " CHF" },
  { code: "JPY", dimension: "currency", factor: 1, aliases: ["¥", "yen"], suffix: " ¥" },
  { code: "CAD", dimension: "currency", factor: 1, aliases: [], suffix: " CAD" },
  { code: "AUD", dimension: "currency", factor: 1, aliases: [], suffix: " AUD" },
  { code: "SEK", dimension: "currency", factor: 1, aliases: [], suffix: " SEK" },
  { code: "NOK", dimension: "currency", factor: 1, aliases: [], suffix: " NOK" },
  { code: "DKK", dimension: "currency", factor: 1, aliases: [], suffix: " DKK" },
  { code: "PLN", dimension: "currency", factor: 1, aliases: ["zł"], suffix: " PLN" },
  { code: "CZK", dimension: "currency", factor: 1, aliases: [], suffix: " CZK" },

  // mass — base gram
  { code: "mg", dimension: "mass", factor: 0.001, aliases: ["milligram", "milligrams"], suffix: " mg" },
  { code: "g", dimension: "mass", factor: 1, aliases: ["gram", "grams", "gramm"], suffix: " g" },
  {
    code: "kg",
    dimension: "mass",
    factor: 1000,
    aliases: ["kilo", "kilos", "kilogram", "kilograms", "kilogramm"],
    suffix: " kg",
  },
  { code: "t", dimension: "mass", factor: 1e6, aliases: ["ton", "tons", "tonne", "tonnes"], suffix: " t" },
  { code: "oz", dimension: "mass", factor: 28.349523125, aliases: ["ounce", "ounces"], suffix: " oz" },
  { code: "lb", dimension: "mass", factor: 453.59237, aliases: ["lbs"], suffix: " lb" },

  // length — base metre
  { code: "mm", dimension: "length", factor: 0.001, aliases: ["millimeter", "millimeters", "millimetre", "millimetres"], suffix: " mm" },
  { code: "cm", dimension: "length", factor: 0.01, aliases: ["centimeter", "centimeters", "centimetre", "centimetres"], suffix: " cm" },
  { code: "m", dimension: "length", factor: 1, aliases: ["meter", "meters", "metre", "metres"], suffix: " m" },
  { code: "km", dimension: "length", factor: 1000, aliases: ["kilometer", "kilometers", "kilometre", "kilometres"], suffix: " km" },
  { code: "mi", dimension: "length", factor: 1609.344, aliases: ["mile", "miles"], suffix: " mi" },
  { code: "ft", dimension: "length", factor: 0.3048, aliases: ["foot", "feet"], suffix: " ft" },
  { code: "inch", dimension: "length", factor: 0.0254, aliases: ["inches"], suffix: " inch" },

  // time — base second
  { code: "ms", dimension: "time", factor: 0.001, aliases: ["millisecond", "milliseconds"], suffix: " ms" },
  { code: "s", dimension: "time", factor: 1, aliases: ["sec", "secs", "second", "seconds"], suffix: " s" },
  { code: "min", dimension: "time", factor: 60, aliases: ["mins", "minute", "minutes"], suffix: " min" },
  { code: "h", dimension: "time", factor: 3600, aliases: ["hr", "hrs", "hour", "hours"], suffix: " h" },
  { code: "d", dimension: "time", factor: 86400, aliases: ["day", "days"], suffix: " d" },

  // data — base byte, binary 1024 (matches display.ts formatFileSize)
  { code: "B", dimension: "data", factor: 1, aliases: ["byte", "bytes"], suffix: " B" },
  { code: "KB", dimension: "data", factor: 1024, aliases: ["kilobyte", "kilobytes"], suffix: " KB" },
  { code: "MB", dimension: "data", factor: 1024 ** 2, aliases: ["megabyte", "megabytes"], suffix: " MB" },
  { code: "GB", dimension: "data", factor: 1024 ** 3, aliases: ["gigabyte", "gigabytes"], suffix: " GB" },
  { code: "TB", dimension: "data", factor: 1024 ** 4, aliases: ["terabyte", "terabytes"], suffix: " TB" },

  // none — display-only, never convertible (not even to each other)
  { code: "BPM", dimension: "none", factor: 1, aliases: [], suffix: " BPM" },
  { code: "LUFS", dimension: "none", factor: 1, aliases: [], suffix: " LUFS" },
  { code: "dB", dimension: "none", factor: 1, aliases: ["decibel", "decibels"], suffix: " dB" },
  { code: "%", dimension: "none", factor: 1, aliases: ["percent", "pct", "prozent"], suffix: " %" },
];

// Lowercase match form → definition. A duplicate alias is a registry bug with
// no honest resolution (whichever unit wins, the other silently stops being
// typeable), so it throws at load instead of picking a winner.
const ALIAS_INDEX: Map<string, UnitDef> = (() => {
  const index = new Map<string, UnitDef>();
  for (const def of UNITS) {
    for (const alias of [def.code.toLowerCase(), ...def.aliases]) {
      const seen = index.get(alias);
      if (seen === def) continue; // a code that repeats one of its own aliases
      if (seen) throw new Error(`unit alias “${alias}” claimed by both ${seen.code} and ${def.code}`);
      index.set(alias, def);
    }
  }
  return index;
})();

/** One unit by any of its match forms, case-insensitively — code or alias.
    undefined when the token names no unit we know. */
export function resolveUnit(token: string): UnitDef | undefined {
  return ALIAS_INDEX.get(token.trim().toLowerCase());
}

// ---------- parsing ----------

// Symbol units may lead ("$25", "-€1.234,56"); word units always trail. A sign
// in front of the symbol belongs to the number.
const SYMBOL_PREFIX_RE = /^([+-]?)\s*([€$£¥])\s*(.+)$/;
// Number head, then whatever trails it. The number's own dialect is settled by
// normalizeNumberInput/parseStrictNumber, not here — this only finds the seam.
const NUMBER_HEAD_RE = /^([+-]?(?:[0-9][0-9.,]*|\.[0-9]+))\s*(.*)$/;

function readNumber(text: string): number | null {
  return parseStrictNumber(normalizeNumberInput(text));
}

/** Text → quantity: "25 USD", "25USD", "1.234,56 €", "$25", "5 kg", "128 BPM",
    or a plain "42" (unit null). null when the text isn't a quantity at all —
    including a number followed by a unit we don't know ("25 furlongs"), which
    stays text rather than quietly becoming a bare 25. */
export function parseQuantity(text: string): Quantity | null {
  const t = text.trim();
  if (t === "") return null;

  const prefixed = SYMBOL_PREFIX_RE.exec(t);
  if (prefixed) {
    const unit = resolveUnit(prefixed[2]);
    if (!unit) return null;
    // Everything after the symbol must be the whole number — "$25 kg" has no
    // honest reading, so it isn't one.
    const value = readNumber(prefixed[1] + prefixed[3]);
    return value === null ? null : { value, unit: unit.code };
  }

  const m = NUMBER_HEAD_RE.exec(t);
  if (!m) return null;
  const value = readNumber(m[1]);
  if (value === null) return null;
  const rest = m[2].trim();
  if (rest === "") return { value, unit: null };
  const unit = resolveUnit(rest);
  return unit ? { value, unit: unit.code } : null;
}

// ---------- conversion ----------

/** Are two units interchangeable? Dimension equality, except that "none"
    units (BPM, LUFS, dB, %) are only ever their own dimension-mates: they
    share the "none" label but converting between them is meaningless, so this
    answers exactly what `convert` will accept. Unknown codes → false. */
export function sameDimension(a: string, b: string): boolean {
  const ua = resolveUnit(a);
  const ub = resolveUnit(b);
  if (!ua || !ub) return false;
  if (ua.dimension !== ub.dimension) return false;
  return ua.dimension === "none" ? ua.code === ub.code : true;
}

/** Convert a quantity to another unit. Errors are values here, as everywhere
    in the formula layer: a plain number, an unknown unit, a missing FX rate or
    a cross-dimension ask all come back as an FErr the caller propagates. */
export function convert(q: Quantity, to: string, fx: FxResolver): number | FErr {
  if (q.unit === null) return ferr("that number has no unit to convert from");
  const from = resolveUnit(q.unit);
  if (!from) return ferr(`unknown unit “${q.unit}”`);
  const target = resolveUnit(to);
  if (!target) return ferr(`unknown unit “${to}”`);
  if (from.code === target.code) return q.value;
  if (from.dimension === "currency" && target.dimension === "currency") {
    const rate = fx(from.code, target.code);
    if (rate === null || !isFinite(rate)) return ferr(`no FX rate for ${from.code}→${target.code}`);
    return q.value * rate;
  }
  if (from.dimension !== target.dimension || from.dimension === "none") {
    return ferr(`can't convert ${from.code} to ${target.code}`);
  }
  return (q.value * from.factor) / target.factor;
}

// ---------- display ----------

/** A quantity as text. "de" is the app's own dialect (1.234,56), "intl" the
    en-US one (1,234.56) — both at most 2 fraction digits, pre-rounded like
    display.ts formatNumber so float noise (0.1 + 0.2) and -0 don't leak. The
    unit contributes its suffix; a unit we don't know still gets spelled out
    rather than silently dropped. */
export function formatQuantity(value: number, unit: string | null, style: "de" | "intl"): string {
  const r = Math.round(value * 100) / 100 || 0;
  const s = r.toLocaleString(style === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 2 });
  if (unit === null) return s;
  const def = resolveUnit(unit);
  return `${s}${def ? def.suffix : ` ${unit}`}`;
}
