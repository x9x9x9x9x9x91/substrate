import { useEffect, useState } from "react";
import { widgetSummarySupported } from "../lib/ipc.ts";
import { isTauri } from "../lib/tauri.ts";
import type { NoteMeta } from "../lib/types.ts";
import { refreshWidgetSummary } from "../lib/widgets.ts";
import { resolveCardValues } from "../components/MetricCards.tsx";
import { useFxRates } from "../components/useFx.ts";

let supported: Promise<boolean> | null = null;
let summaryGeneration = 0;

/** Keep WidgetKit's App Group cache aligned with the latest in-app index.
    A pull and an ordinary vault change both advance vaultEpoch, so they share
    one write path. Widget taps deep-link back through the ordinary
    `substrate://note/…` route — no widget-specific navigation exists. */
export function useWidgetSummary(notes: NoteMeta[], vaultEpoch: number) {
  // The FX subscription stays disabled until the backend confirms the iOS
  // build AND a widget is actually placed: `useFxRates(true)` triggers the
  // app-wide rates fetch, and neither a desktop session (the net-switches
  // spec pins that at zero) nor a widget-less phone should pay for it. The
  // refresh itself reports the placement count, so the first refresh runs on
  // cached/absent rates and the live table arrives for the next one.
  const [widgetsHere, setWidgetsHere] = useState(false);
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    supported ??= widgetSummarySupported();
    supported.then((yes) => setWidgetsHere(yes)).catch(() => {});
  }, []);
  const { fx: rates } = useFxRates(widgetsHere && placed);
  // A widget added while the app was backgrounded has a configuration nothing
  // else announces — its card is exported the moment the app is foregrounded
  // again, which on iOS surfaces as the webview becoming visible.
  const [foregrounds, setForegrounds] = useState(0);
  useEffect(() => {
    if (!isTauri) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") setForegrounds((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  useEffect(() => {
    if (!isTauri || notes.length === 0) return;
    let cancelled = false;
    const generation = ++summaryGeneration;
    supported ??= widgetSummarySupported();
    supported
      .then(async (yes) => {
        if (!yes || cancelled) return;
        const count = await refreshWidgetSummary(
          notes,
          (cards) => resolveCardValues(cards, vaultEpoch, rates),
          () => !cancelled && generation === summaryGeneration,
        );
        if (!cancelled) setPlaced(count > 0);
      })
      .catch((error) => console.warn("widget summary refresh failed", error));
    return () => {
      cancelled = true;
    };
  }, [notes, vaultEpoch, rates, foregrounds]);
}
