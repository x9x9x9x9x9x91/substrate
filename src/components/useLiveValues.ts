/** Live values in prose: the sheets a note body's `` `= expr` ``
    spans read, loaded and evaluated for the editor to render against.

    Deliberately the same shape as the metric cards' own binding
    (MetricCards.useCardValues) and going through the same loader, so a note
    with a live value and a dashboard bound to the same sheet share one
    IPC + BFS + evaluation pass at a given vault epoch and FX table. Nothing
    new subscribes to anything: the vault epoch is the invalidation, exactly
    as it is for every other sheet-bound surface. */

import { useEffect, useMemo, useState } from "react";
import { dashboardSheets, type DashboardSheetState } from "../lib/dashboardSheets";
import { liveSheetNames } from "../lib/livevalues";
import type { FxRatesState } from "../lib/fx";

const EMPTY: Map<string, DashboardSheetState> = new Map();

export function useLiveValues(
  /** the note body, or null while it loads */
  body: string | null,
  vaultEpoch: number,
  /** the hosting note's path — a different note re-reads its expressions */
  scope: string,
  /** the whole quoted rate table: a live expression may convert any
      pair its sheet quotes, not only USD→EUR */
  rates: FxRatesState | null,
): Map<string, DashboardSheetState> {
  const [sheets, setSheets] = useState<Map<string, DashboardSheetState>>(EMPTY);
  const sheetNames = useMemo(() => (body ? liveSheetNames(body) : []), [body]);
  const key = sheetNames.join("|");

  useEffect(() => {
    // prose with no live expressions costs nothing: no load, and the return
    // below hands back the one shared empty Map rather than a fresh one per
    // keystroke — a new identity there would reconfigure the editor's facet
    // and rebuild every decoration for nothing
    if (sheetNames.length === 0) return;
    let gone = false;
    dashboardSheets(sheetNames, vaultEpoch, rates)
      .then((next) => {
        if (!gone) setSheets(next);
      })
      // a rejected pass surfaces as a per-sheet error, so the expression shows
      // the quiet dash with a reason rather than a stale number
      .catch((error) => {
        if (gone) return;
        const msg = error instanceof Error ? error.message : String(error);
        setSheets(
          new Map(sheetNames.map((n) => [n.toLowerCase(), { error: `sheet load failed: ${msg}` }])),
        );
      });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, vaultEpoch, key, rates]);

  // A note whose last live expression was just deleted keeps whatever it had
  // loaded in state; report empty so nothing renders from a stale map.
  return sheetNames.length === 0 ? EMPTY : sheets;
}
