/** Global FX cache (SUB-386; multi-currency table SUB-834). Rates are one
    app-wide value, so they live in localStorage — never in note frontmatter.
    The old per-note fx_rate/fx_date props stamped machine cache into real data
    files (and leaked into database columns); notes carry no fx props anymore. */

import type { FxResolver } from "./formula.ts";

export interface FxState {
  usdEur: number;
  asOf: string;
  live: boolean;
}

/** The whole majors table as the engine hands it over: every rate quoted
    against `base`, so any pair converts through it in one hop each way. */
export interface FxRatesState {
  base: string;
  rates: Record<string, number>;
  asOf: string;
  live: boolean;
}

export const FX_CACHE_KEY = "substrate.fx.usdEur";
export const FX_RATES_CACHE_KEY = "substrate.fx.rates";

/** The mock backend's deterministic starting rate — what its fixtures used
    to carry in frontmatter, so e2e baselines stay stable offline. */
export const MOCK_FX: FxState = { usdEur: 0.8721, asOf: "2026-07-16", live: false };

/** The offline table, EUR-based like the live one.

    USD is written out rather than computed as `1 / MOCK_FX.usdEur`: 0.8721
    has no exact reciprocal in a double, and the obvious expression rounds
    back to 0.8720999999999999 — one ULP low, which is enough to move a
    fixture cell by a cent (23.939,15 → 23.939,14 on the Holdings sheet).
    This literal is the neighbour whose reciprocal renders every fixture
    figure exactly as the single-pair rate did; `the mock table quotes
    USD→EUR at the mock single rate` in fx.test.ts guards it. */
export const MOCK_FX_RATES: FxRatesState = {
  base: "EUR",
  rates: {
    USD: 1.1466574934067193,
    GBP: 0.86445,
    CHF: 0.9312,
    JPY: 171.24,
    CAD: 1.5941,
    AUD: 1.7823,
    SEK: 11.0842,
    NOK: 11.7615,
    DKK: 7.4602,
    PLN: 4.2678,
    CZK: 24.615,
  },
  asOf: MOCK_FX.asOf,
  live: false,
};

/** Parse a cached fx entry; null on anything malformed. Exported pure for
    unit tests — storage access stays in the hook. */
export function parseFxCache(raw: string | null): FxState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { usdEur?: unknown; asOf?: unknown };
    if (typeof p.usdEur !== "number" || !isFinite(p.usdEur) || p.usdEur <= 0) return null;
    return { usdEur: p.usdEur, asOf: typeof p.asOf === "string" ? p.asOf : "", live: false };
  } catch {
    return null;
  }
}

export function serializeFxCache(r: { usdEur: number; asOf: string }): string {
  return JSON.stringify({ usdEur: r.usdEur, asOf: r.asOf });
}

/** Same contract for the table: null on anything malformed, and a single bad
    row is dropped rather than costing the whole cached table (the engine
    parser drops per-symbol junk the same way). A table with no usable row
    left is null — a refresh is better than converting through nothing. */
export function parseFxRatesCache(raw: string | null): FxRatesState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { base?: unknown; rates?: unknown; asOf?: unknown };
    if (typeof p.base !== "string" || !p.base) return null;
    if (typeof p.rates !== "object" || p.rates === null) return null;
    const rates: Record<string, number> = {};
    for (const [code, v] of Object.entries(p.rates as Record<string, unknown>)) {
      if (typeof v !== "number" || !isFinite(v) || v <= 0) continue;
      rates[code.toUpperCase()] = v;
    }
    if (Object.keys(rates).length === 0) return null;
    return {
      base: p.base.toUpperCase(),
      rates,
      asOf: typeof p.asOf === "string" ? p.asOf : "",
      live: false,
    };
  } catch {
    return null;
  }
}

export function serializeFxRatesCache(r: {
  base: string;
  rates: Record<string, number>;
  asOf: string;
}): string {
  return JSON.stringify({ base: r.base, rates: r.rates, asOf: r.asOf });
}

/** The base's own rate is 1 and never rides in the table — frankfurter omits
    it, so every lookup has to account for it rather than reading undefined. */
function rateOf(state: FxRatesState, code: string): number | null {
  if (code === state.base) return 1;
  const r = state.rates[code];
  return typeof r === "number" && isFinite(r) && r > 0 ? r : null;
}

/** The one FX resolver the sheet engine, metric cards and charts share
    (SUB-834). Any pair converts through the table's base — from→base→to —
    so eleven quoted majors cover every cross rate between them. Unknown code
    on either side is null, which the engine reports as a missing rate rather
    than a wrong figure. */
export function makeFxResolver(state: FxRatesState | null): FxResolver {
  return (from, to) => {
    if (!state) return null;
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return 1;
    const fr = rateOf(state, f);
    const tr = rateOf(state, t);
    if (fr === null || tr === null) return null;
    const rate = tr / fr;
    return isFinite(rate) && rate > 0 ? rate : null;
  };
}

/** The single pair the pre-table surfaces still read, derived from the table
    so there is one source of truth for it (SUB-834). null when the table
    can't quote USD→EUR. */
export function usdEurFrom(state: FxRatesState | null): FxState | null {
  if (!state) return null;
  const rate = makeFxResolver(state)("USD", "EUR");
  return rate === null ? null : { usdEur: rate, asOf: state.asOf, live: state.live };
}
