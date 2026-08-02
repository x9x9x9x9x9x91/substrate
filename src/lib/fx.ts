/** Global USD→EUR cache (SUB-386). The rate is one app-wide value, so it
    lives in localStorage — never in note frontmatter. The old per-note
    fx_rate/fx_date props stamped machine cache into real data files (and
    leaked into database columns); notes carry no fx props anymore. */

export interface FxState {
  usdEur: number;
  asOf: string;
  live: boolean;
}

export const FX_CACHE_KEY = "substrate.fx.usdEur";

/** The mock backend's deterministic starting rate — what its fixtures used
    to carry in frontmatter, so e2e baselines stay stable offline. */
export const MOCK_FX: FxState = { usdEur: 0.8721, asOf: "2026-07-16", live: false };

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
