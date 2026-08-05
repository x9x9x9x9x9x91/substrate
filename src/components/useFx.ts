import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fxRates, vaultRead } from "../lib/ipc";
import { netAllowed, SETTINGS_PATH } from "../lib/settings";
import {
  FX_CACHE_KEY,
  FX_RATES_CACHE_KEY,
  MOCK_FX_RATES,
  parseFxCache,
  parseFxRatesCache,
  serializeFxRatesCache,
  usdEurFrom,
  type FxRatesState,
  type FxState,
} from "../lib/fx";
import { isTauri } from "../lib/tauri";

function readCache(): FxRatesState | null {
  try {
    const cached = parseFxRatesCache(localStorage.getItem(FX_RATES_CACHE_KEY));
    if (cached) return cached;
    // an install that only ever cached the single pair (pre) starts
    // from a one-row table rather than blank, so the first paint after an
    // update still converts USD→EUR while the live refresh is in flight
    const old = parseFxCache(localStorage.getItem(FX_CACHE_KEY));
    if (old) {
      return { base: "EUR", rates: { USD: 1 / old.usdEur }, asOf: old.asOf, live: false };
    }
  } catch {
    /* storage unavailable — fall through */
  }
  // the mock backend starts from the fixtures' historical rates so e2e
  // baselines don't depend on the network
  return isTauri ? null : MOCK_FX_RATES;
}

function writeCache(r: { base: string; rates: Record<string, number>; asOf: string }) {
  try {
    localStorage.setItem(FX_RATES_CACHE_KEY, serializeFxRatesCache(r));
  } catch {
    /* cache is best-effort */
  }
}

type FxSnapshot = { fx: FxRatesState | null; err: string | null };

let snapshot: FxSnapshot | null = null;
let refreshInFlight: Promise<void> | null = null;
let autoRefreshStarted = false;
const listeners = new Set<() => void>();

function getSnapshot(): FxSnapshot {
  return (snapshot ??= { fx: readCache(), err: null });
}

function publish(next: FxSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One refresh transaction for the entire renderer. Concurrent consumers
    share both the promise and the resulting snapshot, so they cannot issue
    duplicate requests or settle on different live/stale tables. */
function requestRefresh(force: boolean): void {
  if (refreshInFlight || (!force && autoRefreshStarted)) return;
  autoRefreshStarted = true;
  refreshInFlight = vaultRead(SETTINGS_PATH)
    .then((c) => netAllowed(c.props, "fx-rates"))
    .catch(() => true)
    .then(async (allowed) => {
      if (!allowed) return;
      try {
        const rates = await fxRates();
        publish({ fx: { ...rates, live: true }, err: null });
        writeCache(rates);
      } catch (e: unknown) {
        publish({ fx: getSnapshot().fx, err: String(e) });
      }
    })
    .finally(() => {
      refreshInFlight = null;
    });
}

const refreshFxRates = () => requestRefresh(true);
export const ensureFxRates = () => requestRefresh(false);

/** The one FX source for sheets, dashboards, databases and calc notes
    (a whole multi-currency table since the shared resolver landed): cached
    app-wide, refreshed once on
    first enabled use, never written to any note. `err` carries the last
    refresh failure so a pane can say the rates
    are stale instead of silently showing the cached ones.

    This is also the single call-site seam for the fetch — a privacy toggle
    gates it here, not in each consumer. */
export function useFxRates(enabled = true): {
  fx: FxRatesState | null;
  err: string | null;
  refresh: () => void;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (enabled) ensureFxRates();
  }, [enabled]);
  return { ...current, refresh: refreshFxRates };
}

/** The single USD→EUR pair, derived from the same table and the same refresh
    — the surfaces that only quote that one rate keep their old shape without
    a second fetch. */
export function useUsdEur(enabled = true): { fx: FxState | null; err: string | null; refresh: () => void } {
  const { fx: rates, err, refresh } = useFxRates(enabled);
  const fx = useMemo(() => usdEurFrom(rates), [rates]);
  return { fx, err, refresh };
}
