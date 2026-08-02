import { useCallback, useEffect, useState } from "react";
import { fxUsdEur } from "../lib/ipc";
import { FX_CACHE_KEY, MOCK_FX, parseFxCache, serializeFxCache, type FxState } from "../lib/fx";
import { isTauri } from "../lib/tauri";

function readCache(): FxState | null {
  try {
    const cached = parseFxCache(localStorage.getItem(FX_CACHE_KEY));
    if (cached) return cached;
  } catch {
    /* storage unavailable — fall through */
  }
  // the mock backend starts from the fixtures' historical rate so e2e
  // baselines don't depend on the network
  return isTauri ? null : MOCK_FX;
}

function writeCache(r: { usdEur: number; asOf: string }) {
  try {
    localStorage.setItem(FX_CACHE_KEY, serializeFxCache(r));
  } catch {
    /* cache is best-effort */
  }
}

/** The one FX source for sheets and dashboards (SUB-386): cached app-wide,
    refreshed live on mount, never written to any note. `err` carries the last
    refresh failure so a pane can say the rate is stale instead of silently
    showing the cached one (SUB-667). */
export function useUsdEur(): { fx: FxState | null; err: string | null; refresh: () => void } {
  const [fx, setFx] = useState<FxState | null>(readCache);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(() => {
    fxUsdEur().then(
      (r) => {
        setErr(null);
        setFx({ ...r, live: true });
        writeCache(r);
      },
      (e: unknown) => setErr(String(e)),
    );
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { fx, err, refresh };
}
