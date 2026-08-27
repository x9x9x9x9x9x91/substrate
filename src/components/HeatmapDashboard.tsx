/** Heatmap dashboard: the ```heatmap fences in a note, each drawn as
    a year of day squares — the contribution-graph read of a database or a
    sheet. Parsing and aggregation live in lib/heatmap.ts; this file is layout,
    intensity and the keyboard.

    The idiom is ChartsDashboard's, deliberately: the same embed/full split (so
    a hub can host a fence in the slot it was written into), the same
    `DashAlert` in-place error (a broken fence never takes its siblings down),
    the same provenance foot. */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { sheetRows, unknownDbSource } from "../lib/chart";
import { formatDateHuman, shiftDate, toIso } from "../lib/dates";
import {
  heatmapDbRows,
  heatmapGrid,
  heatmapNeedsMessage,
  heatmapSourceDesc,
  heatmapTitle,
  heatmapYears,
  parseHeatmapBlocks,
  pickHeatmapYear,
  tallyHeatmap,
  type HeatmapBlock,
  type HeatmapConfig,
  type HeatmapDay,
  type HeatmapTally,
} from "../lib/heatmap";
import { numberLocale } from "../lib/numberLocale";
import { useNumberLocale } from "../hooks/useNumberLocale";
import { DashHead, DashPrintButton } from "./DashHead";
import { dashboardSheets, type DashboardSheetState } from "../lib/dashboardSheets";
import { useFxRates } from "./useFx";
import { DashAlert, DashEmpty, DashFoot } from "./DashNotice";
import { errText } from "../lib/errtext";

interface HeatmapDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  body: string;
  vaultEpoch: number;
  schema: SchemaConfig;
  onOpenSource: (path: string) => void;
  /** render only the heatmap sections — no pane chrome — so another dashboard
      (a hub, the fence host) can place one where it was written */
  embed?: boolean;
}

/** the dial's dialect, full precision — a square's number is small. The module
    binding, like the charts dashboard's own figures: nothing threads a locale
    this deep, and the plot subscribes to the dial so a change repaints. */
function fmtNum(v: number): string {
  return v.toLocaleString(numberLocale(), { maximumFractionDigits: 2 });
}

/** What a square says, in the tooltip and to a screen reader. A `count` day
    states its rows once; a `sum:` day states the total AND how many rows made
    it, because a zero-summing day with rows behind it is not an empty day. */
function dayLabel(day: HeatmapDay, config: HeatmapConfig): string {
  const when = formatDateHuman(day.iso);
  if (config.value.fn === "count")
    return day.n === 0 ? `${when} — nothing` : `${when} — ${day.n} ${day.n === 1 ? "entry" : "entries"}`;
  if (day.n === 0) return `${when} — nothing`;
  return `${when} — ${fmtNum(day.value)} ${config.value.prop} · ${day.n} ${day.n === 1 ? "row" : "rows"}`;
}

const LEVELS = [0, 1, 2, 3, 4];
/** Monday-first, matching the grid's columns (lib/heatmap weekdayIndex) */
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** One year of squares plus the controls that read it: a year switch when the
    source spans more than one, a legend, and a live readout that says what the
    cursor is on. */
function HeatmapPlot({ config, tally }: { config: HeatmapConfig; tally: HeatmapTally }) {
  // subscribe for the repaint, not the value: every number here goes through
  // fmtNum's module binding, and the tooltip/legend strings are computed inside
  // this component — without the subscription a dial change leaves the old
  // dialect on screen until something unrelated re-renders
  useNumberLocale();
  const gridId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const years = useMemo(() => heatmapYears(tally), [tally]);
  const [picked, setPicked] = useState<number | null>(null);
  // a pick only holds while the data still carries that year — a vault edit
  // that drops the year falls back to the derived one instead of a blank grid
  const year = picked !== null && years.includes(picked) ? picked : pickHeatmapYear(tally);
  const grid = useMemo(() => heatmapGrid(tally, year), [tally, year]);
  const days = useMemo(() => {
    const m = new Map<string, HeatmapDay>();
    for (const week of grid.weeks) for (const d of week) if (d) m.set(d.iso, d);
    return m;
  }, [grid]);

  // Keyboard cursor: the grid is ONE tab stop (365 of them would make the page
  // untraversable), and the arrows walk it — down/up by a day, right/left by a
  // week, which is what the columns are. aria-activedescendant carries the
  // position to a screen reader; the readout line carries it to everyone else.
  const [cursor, setCursor] = useState<string | null>(null);
  const cur = cursor !== null && days.has(cursor) ? cursor : null;
  const first = toIso(year, 1, 1);
  const last = toIso(year, 12, 31);
  /** where an arrow lands when nothing is focused yet: the newest day that
      actually carries rows, so the first keypress starts where the data is */
  const entry = useMemo(() => {
    let hit: string | null = null;
    for (const [iso, d] of days) if (d.n > 0 && (hit === null || iso > hit)) hit = iso;
    return hit ?? first;
  }, [days, first]);

  const step = useCallback(
    (delta: number) => {
      if (cur === null) {
        setCursor(entry);
        return;
      }
      const next = shiftDate(cur, delta);
      if (next >= first && next <= last) setCursor(next);
    },
    [cur, entry, first, last],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const by: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      ArrowRight: 7,
      ArrowLeft: -7,
      PageDown: 28,
      PageUp: -28,
    };
    if (e.key in by) {
      e.preventDefault();
      step(by[e.key]);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setCursor(e.key === "Home" ? first : last);
    }
  };

  const readout =
    cur !== null
      ? dayLabel(days.get(cur)!, config)
      : `${year} — ${grid.active} ${grid.active === 1 ? "day" : "days"} with rows, ${fmtNum(grid.total)} total`;

  return (
    <div className="heatmap">
      {years.length > 1 && (
        <div className="heatmap-years">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              className={`heatmap-year${y === year ? " is-on" : ""}`}
              aria-pressed={y === year}
              onClick={() => setPicked(y)}
            >
              {y}
            </button>
          ))}
        </div>
      )}

      <div className="heatmap-scroll">
        <div className="heatmap-plot" style={{ "--weeks": grid.weeks.length } as CSSProperties}>
          <div />
          <div className="heatmap-months" aria-hidden="true">
            {grid.months.map((m) => (
              <span key={m.label} style={{ gridColumn: m.col + 1 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="heatmap-wd" aria-hidden="true">
            {WEEKDAYS.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
          <div
            className="heatmap-grid"
            ref={gridRef}
            role="grid"
            tabIndex={0}
            aria-label={`${heatmapTitle(config)}, ${year}. Arrow up and down move by day, left and right by week.`}
            aria-activedescendant={cur !== null ? `${gridId}-${cur}` : undefined}
            onKeyDown={onKeyDown}
          >
            {grid.weeks.map((week, w) => (
              // a column IS a week here, so it is the grid's row for AT
              // purposes; the cursor is carried by aria-activedescendant, not
              // by DOM focus, so the visual/semantic axes never disagree
              <div className="heatmap-week" role="row" key={w}>
                {week.map((d, i) =>
                  d === null ? (
                    // padding outside the year: not a day, so not a cell
                    <div className="heatmap-pad" key={i} />
                  ) : (
                    // the grid owns the keyboard; a cell is a pointer target only
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                    <div
                      key={d.iso}
                      id={`${gridId}-${d.iso}`}
                      role="gridcell"
                      // referenced by aria-activedescendant, so it must be
                      // focusable — but never its own tab stop
                      tabIndex={-1}
                      className={`heatmap-day${cur === d.iso ? " is-cursor" : ""}`}
                      data-level={d.level}
                      title={dayLabel(d, config)}
                      aria-label={dayLabel(d, config)}
                      aria-selected={cur === d.iso}
                      onClick={() => {
                        setCursor(d.iso);
                        gridRef.current?.focus();
                      }}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="heatmap-under">
        <div className="heatmap-readout" aria-live="polite">
          {readout}
        </div>
        <div className="heatmap-legend" aria-hidden="true">
          <span>Less</span>
          {LEVELS.map((l) => (
            <span
              key={l}
              className="heatmap-key"
              data-level={l}
              title={l === 0 ? "nothing" : `up to ${fmtNum((grid.max * l) / 4)}`}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

/** One fence: its title, its grid or the reason there isn't one, its foot. */
function HeatmapSection({
  block,
  tally,
  loadError,
}: {
  block: HeatmapBlock;
  tally: HeatmapTally | null;
  loadError: string | null;
}) {
  // a fence still being written is not a broken one: it gets the calm state
  // that names what it is waiting for, in the same words the fence's own keys
  // are documented in. The error banner stays for config that IS wrong.
  if (block.needs) {
    return (
      <div>
        <div className="dash-section-label">Heatmap block</div>
        <DashEmpty>{heatmapNeedsMessage(block.needs)}</DashEmpty>
      </div>
    );
  }
  if (block.error || !block.config) {
    return (
      <div>
        <div className="dash-section-label">Heatmap block</div>
        <DashAlert>{block.error ?? "invalid heatmap block"}</DashAlert>
      </div>
    );
  }
  const c = block.config;
  return (
    <div>
      <div className="dash-section-label">{heatmapTitle(c)}</div>
      {loadError ? (
        <DashAlert>{loadError}</DashAlert>
      ) : tally === null ? (
        <div className="dash-foot" style={{ margin: "4px 0 0" }}>
          …
        </div>
      ) : tally.missing ? (
        // a bound property that exists nowhere in the source is a named error,
        // not an empty year — the same call the chart makes
        <DashAlert>{tally.missing}</DashAlert>
      ) : (
        <HeatmapPlot config={c} tally={tally} />
      )}
      <DashFoot
        facts={[
          heatmapSourceDesc(c),
          c.query ? `query: ${c.query}` : "",
          tally && tally.skipped > 0 ? `${tally.skipped} rows skipped` : "",
        ]}
      />
    </div>
  );
}

export default function HeatmapDashboard({
  meta,
  notes,
  body,
  vaultEpoch,
  schema,
  onOpenSource,
  embed,
}: HeatmapDashboardProps) {
  const blocks = useMemo(() => parseHeatmapBlocks(body), [body]);
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of blocks) {
      const s = b.config?.source;
      if (s?.kind === "sheet") seen.set(s.name.toLowerCase(), s.name);
    }
    return [...seen.values()];
  }, [blocks]);
  // Same cross-sheet loader the charts dashboard draws with:
  // every charted sheet — and transitively any sheet its formulas reference —
  // read once and evaluated with the cross-sheet loader, the epoch/rate cache
  // sharing that work with any chart fences composed alongside these grids.
  const { fx: rates } = useFxRates();
  const [sheets, setSheets] = useState<Map<string, DashboardSheetState>>(new Map());
  useEffect(() => {
    let gone = false;
    dashboardSheets(sheetNames, vaultEpoch, rates)
      .then((next) => {
        if (!gone) setSheets(next);
      })
      // a rejected pass (evicted from the cache) surfaces as a per-sheet
      // error instead of leaving every grid loading forever
      .catch((error) => {
        if (gone) return;
        const msg = errText(error);
        setSheets(
          new Map(sheetNames.map((n) => [n.toLowerCase(), { error: `sheet load failed: ${msg}` }])),
        );
      });
    // the flag exists to drop a stale pass; without this cleanup it never
    // flipped, so a slow earlier load could overwrite a newer one
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.path, vaultEpoch, sheetNames.join("|"), rates]);

  const tallyFor = (block: HeatmapBlock): { tally: HeatmapTally | null; loadError: string | null } => {
    const c = block.config;
    if (!c) return { tally: null, loadError: null };
    if (c.source.kind === "db") {
      // same existence check the chart fences and the view fences make: a
      // misspelled type is a named error, not an empty grid
      const unknown = unknownDbSource(notes, schema, c.source.type);
      if (unknown) return { tally: null, loadError: unknown };
      return { tally: tallyHeatmap(heatmapDbRows(c, notes, schema), c), loadError: null };
    }
    const state = sheets.get(c.source.name.toLowerCase());
    if (!state) return { tally: null, loadError: null };
    if ("error" in state) return { tally: null, loadError: state.error };
    return { tally: tallyHeatmap(sheetRows(state.model, state.ev), c), loadError: null };
  };

  const sections = blocks.map((b, i) => {
    const { tally, loadError } = tallyFor(b);
    return <HeatmapSection key={i} block={b} tally={tally} loadError={loadError} />;
  });

  if (embed) return <>{sections}</>;

  return (
    <div className="note">
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{ label: `${blocks.length} ${blocks.length === 1 ? "heatmap" : "heatmaps"}` }}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {sections}

        {blocks.length === 0 && (
          <DashEmpty>No heatmaps yet — add a ```heatmap fence to this note.</DashEmpty>
        )}

        <div className="dash-foot">
          Heatmaps are heatmap fences in this note — edit the text to reconfigure them.
        </div>
      </div>
    </div>
  );
}
