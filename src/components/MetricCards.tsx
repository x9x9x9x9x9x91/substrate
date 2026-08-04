/** The metric card strip, shared by the metrics dashboard (cards from
    frontmatter) and hub bodies (cards from a ```cards fence, SUB-964). One
    card contract, one resolution path, one look — a stat card must not read
    differently depending on which surface hosts it. */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { metricsColumns } from "../lib/dashboard";
import { fmtCard, parseBind, type MetricCard } from "../lib/metriccards";
import { dashboardSheets, type DashboardSheetState } from "../lib/dashboardSheets";
import { findSummary } from "../lib/sheet";
import { isErr } from "../lib/formula";
import type { FxRatesState } from "../lib/fx";

export interface CardValue {
  text: string;
  miss?: string;
  title?: string;
}

/** Load every bound sheet — and transitively any sheet its formulas reference
    — then evaluate each with the cross-sheet loader, and read one card's value
    out of the result. The load itself goes through the shared dashboard sheet
    cache (SUB-940), so several card strips on one board — a hub with two
    ```cards fences, say — bound to the same sheet SET cost one IPC + BFS +
    evaluation pass, not one per strip. Strips with different root sets load
    independently (the cache keys on the whole set, not per sheet). */
export function useCardValues(
  cards: MetricCard[],
  vaultEpoch: number,
  /** the hosting note's path — kept as an effect key so a different note
      re-reads its cards; identical sheet roots at one vault epoch and FX rate
      still resolve to the same cached evaluation */
  scope: string,
  /** the whole quoted rate table (SUB-834) — a card's sheet may convert any
      pair, not only USD→EUR */
  rates: FxRatesState | null,
): (i: number) => CardValue {
  const [sheets, setSheets] = useState<Map<string, DashboardSheetState>>(new Map());
  const binds = useMemo(() => cards.map((c) => parseBind(c.bind)), [cards]);
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of binds) {
      if (b) seen.set(b.sheet.toLowerCase(), b.sheet);
    }
    return [...seen.values()];
  }, [binds]);

  useEffect(() => {
    let gone = false;
    dashboardSheets(sheetNames, vaultEpoch, rates)
      .then((next) => {
        if (!gone) setSheets(next);
      })
      // a rejected pass (evicted from the cache) surfaces as a per-sheet
      // error instead of leaving every card on "…" forever
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
  }, [scope, vaultEpoch, sheetNames.join("|"), rates]);

  // A bound summary that doesn't exist is the same class of miss the charts
  // name (SUB-749): renaming it left the card reading "—" with the reason
  // buried in a hover tooltip, which on a dashboard is indistinguishable from
  // a summary that legitimately has no value. The card now says the name it
  // couldn't find; the sheet's actual summary list stays in the tooltip, since
  // a card is too narrow to carry an inventory and hover already answers
  // "then what IS there".
  return (i: number): CardValue => {
    const b = binds[i];
    if (!b) return { text: "—", title: `bad binding “${cards[i].bind}” — want {{Sheet.summary}}` };
    const state = sheets.get(b.sheet.toLowerCase());
    if (!state) return { text: "…" };
    if ("error" in state) return { text: "—", title: state.error };
    const hit = state.ev.summaries.find((s) => s.name.toLowerCase() === b.name.toLowerCase());
    if (!hit) {
      const has = state.ev.summaries.map((s) => s.name).join(", ");
      return {
        text: "—",
        miss: `no summary “${b.name}” on ${b.sheet}`,
        title: `no summary “${b.name}” on ${b.sheet}${has ? ` (has: ${has})` : " (it has none)"}`,
      };
    }
    const v = findSummary(state.ev, b.name);
    return {
      text: fmtCard(v, cards[i].format, cards[i].digits),
      title: isErr(v) ? v.err : undefined,
    };
  };
}

/** The strip itself. `sharp` decides which cards keep the sharp voice — the
    caller owns that set because the cap is per BOARD, not per strip: a hub
    page with several ```cards fences still spends at most two sharp values
    across all of them (principle 11). */
export function MetricCardStrip({
  cards,
  sharp,
  cardValue,
}: {
  cards: MetricCard[];
  sharp: Set<number>;
  cardValue: (i: number) => CardValue;
}) {
  // how the strip wraps into a block (SUB-625) — card count, not viewport
  const cols = metricsColumns(cards.length);
  return (
    <div className="metrics-strip">
      <div
        className="dash-cards metrics-cards"
        // the column count is data, not a breakpoint (SUB-625): it depends
        // on how many cards the note declares, so the grid track comes from
        // the renderer and the stylesheet owns everything else
        style={{ "--metrics-cols": cols } as CSSProperties}
      >
        {cards.map((card, i) => {
          const v = cardValue(i);
          // the binding is chrome, not content — tooltip only, merged
          // with any error title (SUB-246)
          const title = v.title ? `${card.bind} — ${v.title}` : card.bind;
          // the tile that opens a row drops its leading hairline — the
          // rule divides tiles inside a row, it never fences the left
          // edge of one
          const cls = `dash-card${sharp.has(i) ? "" : " sunk"}${i % cols === 0 ? " row-start" : ""}`;
          return (
            <div className={cls} key={i} title={title}>
              <div className="dash-label">{card.label}</div>
              <div className="dash-card-eur">{v.text}</div>
              {v.miss && <div className="dash-card-miss">{v.miss}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
