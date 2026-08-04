import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { NoteMeta, SchemaConfig, SelectOption } from "../lib/types";
import { fmtFx } from "../lib/dashboard";
import { usdEurFrom } from "../lib/fx";
import { useFxRates } from "./useFx";
import { useEdgeFade } from "../hooks/useEdgeFade";
import { dashboardSheets, type DashboardSheetState } from "../lib/dashboardSheets";
import {
  aggregate,
  chartSourceDesc,
  chartTitle,
  dbRows,
  parseChartBlocks,
  sheetRows,
  summarySeries,
  xFractions,
  xSchemaOptions,
  type ChartBand,
  type ChartBlock,
  type ChartConfig,
  type ChartPoint,
  type ChartSeries,
} from "../lib/chart";
import { optionColorVar } from "../lib/dbicons";
import { DashHead, DashPrintButton } from "./DashHead";
import { optionColor } from "./SelectMenu";

interface ChartsDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  body: string;
  vaultEpoch: number;
  schema: SchemaConfig;
  onOpenSource: (path: string) => void;
  /** render only the chart sections — no pane chrome — so another dashboard
      (metrics cards, SUB: finance surface) can host charts below its own
      content */
  embed?: boolean;
  /** An embedding surface may have already run the canonical chart parser.
      Reuse that validated config instead of wrapping its text in a synthetic
      fence and parsing it a second time. */
  configOverride?: ChartConfig;
}

/** full-precision value — tooltips keep every digit */
function fmtFull(v: number): string {
  return v.toLocaleString("de-DE", { maximumFractionDigits: 1 });
}

/** axis hints and bar labels read compact (2026-07-20): millions as
    "4,96M", ten-thousands up as "193k", small values full — a chart label
    is a scan target, the tooltip carries precision */
function fmtVal(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000)
    return `${(v / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 2 })}M`;
  if (a >= 10_000) return `${Math.round(v / 1000).toLocaleString("de-DE")}k`;
  return fmtFull(v);
}

/** One line of a tooltip: a value, plus the band it belongs to when the chart
    is split (`by:`). `band` is the index in the chart's band list, not in the
    tooltip — a band with no rows at this x is absent here but keeps its
    treatment. */
interface TipRow {
  name: string | null;
  band: number;
  value: number;
  n: number;
}

interface TipState {
  label: string;
  rows: TipRow[];
  /** px from the chart wrap's left edge / top edge */
  x: number;
  y: number;
  /** which edge the card hangs from, so the first and last x stay on-screen */
  align: "l" | "c" | "r";
  /** Tall marks and line slots sit near the top; those cards open downward so
      they do not cover the legend above the plot. */
  vertical: "above" | "below";
}

/** The same reading, as one sentence — the tooltip is decoration for a screen
    reader, so the focusable slot carries this on `aria-label` instead. */
function tipText(label: string, rows: TipRow[]): string {
  if (rows.length === 0) return `${label} · no rows`;
  if (rows.length === 1 && rows[0].name === null) {
    const r = rows[0];
    return `${label} · ${fmtFull(r.value)}${r.n > 1 ? ` · ${r.n} rows` : ""}`;
  }
  return `${label} · ${rows.map((r) => `${r.name}: ${fmtFull(r.value)}`).join(", ")}`;
}

/** Hover/focus tooltip shared by both chart kinds (SUB-941). The card is
    positioned inside the chart's own wrap — one element per chart, moved to the
    hovered slot, rather than one card per bar. Anchoring is by the slot's box,
    so a bar's card sits on top of the bar and a line's sits at the plot top. */
function useChartTip() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (el: Element | null, label: string, rows: TipRow[]) => {
    const wrap = wrapRef.current;
    if (!wrap || !el) return;
    const r = el.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const x = r.left - w.left + r.width / 2;
    // no measuring pass: past either edge the card hangs from that side, so a
    // centred card never runs off the first or last slot
    const align = x < TIP_EDGE_PX ? "l" : x > w.width - TIP_EDGE_PX ? "r" : "c";
    const y = r.top - w.top;
    setTip({ label, rows, x, y, align, vertical: y < TIP_FLIP_PX ? "below" : "above" });
  };
  return { wrapRef, tip, show, hide: () => setTip(null) };
}

/** how close to an edge a slot must be before its card hangs from that side */
const TIP_EDGE_PX = 84;
const TIP_FLIP_PX = 96;

function ChartTip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  const multi = tip.rows.length > 1 || (tip.rows[0]?.name ?? null) !== null;
  return (
    // the sentence is already on the slot's aria-label — a screen reader that
    // read both would say every value twice
    <div
      className={`chart-tip is-${tip.align} is-${tip.vertical}`}
      style={{ left: tip.x, top: tip.y }}
      aria-hidden="true"
    >
      <div className="chart-tip-x">{tip.label}</div>
      {tip.rows.map((r) => (
        <div className="chart-tip-row" key={r.band}>
          {multi ? (
            <>
              <span className={`chart-swatch ${bandClass(r.band)}`} />
              <span className="chart-tip-name">{r.name}</span>
            </>
          ) : null}
          <span className="chart-tip-val">{fmtFull(r.value)}</span>
        </div>
      ))}
      {!multi && tip.rows[0] && tip.rows[0].n > 1 ? (
        <div className="chart-tip-n">{tip.rows[0].n} rows</div>
      ) : null}
      {tip.rows.length === 0 ? <div className="chart-tip-n">No rows</div> : null}
    </div>
  );
}

/** The neutral token ramp safely carries two data series. Three or more wait
    on the categorical-palette decision in SUB-952 rather than repeating or
    inventing colors here. */
const BAND_TREATMENTS = 2;

function bandClass(i: number): string {
  return `band-${i % BAND_TREATMENTS}`;
}

/** Compact legend for a `by:` split — a swatch and the band's own value, in
    band order, so the stack reads bottom-up as the legend reads left-right. */
function ChartLegend({ bands }: { bands: ChartBand[] }) {
  return (
    <div className="chart-legend">
      {bands.map((b, i) => (
        <span className="chart-legend-item" key={b.name}>
          <span className={`chart-swatch ${bandClass(i)}`} />
          {b.name}
        </span>
      ))}
    </div>
  );
}

/** Roving tabindex over a chart's x slots: one tab stop per chart, arrows walk
    the axis. 40 bars must not be 40 tab stops — the pattern every grid-like
    widget uses, so the keyboard reading matches the pointer's. */
function useRoving(n: number) {
  const [active, setActive] = useState(0);
  const slots = useRef<(HTMLElement | null)[]>([]);
  const go = (i: number) => {
    const next = Math.max(0, Math.min(n - 1, i));
    setActive(next);
    slots.current[next]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const key = e.key;
    if (key === "ArrowRight") go(i + 1);
    else if (key === "ArrowLeft") go(i - 1);
    else if (key === "Home") go(0);
    else if (key === "End") go(n - 1);
    else return;
    e.preventDefault();
  };
  // a chart that reflows shorter must not keep a tab stop past its own end
  const tabIndexOf = (i: number) => (i === Math.min(active, n - 1) ? 0 : -1);
  return { slots, onKeyDown, tabIndexOf };
}

/** The dashboard accent family's series ramp (SUB-932, design principle 3):
    the sky blues, #6cc0ec first. Fixed order, five entries, each
    contrast-checked on both the dark ground and the print white — a
    categorical chart cycles it so its buckets read as distinct without
    inventing a hue per widget. A time axis is ONE series and never touches
    this: it wears the plain accent. */
const SERIES_RAMP = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
];

/** Bar chart in the dashboard idiom: flat columns, value on top, label below,
    tooltip on hover. For an unsplit chart, colour precedence is: a select x
    axis keeps its schema hues; another categorical axis cycles the V1 series
    ramp; a time axis stays one series in the plain accent. Split charts keep
    their own band treatments. Values and labels thin out when crowded. */
function BarChart({
  points,
  bands,
  xOptions,
  categorical,
}: {
  points: ChartPoint[];
  /** `by:` split — each column stacks its bands bottom-up in band order */
  bands?: ChartBand[] | null;
  xOptions?: SelectOption[];
  /** buckets are categories, not time — colour an unsplit axis with the ramp */
  categorical?: boolean;
}) {
  const { wrapRef, tip, show, hide } = useChartTip();
  const { slots, onKeyDown, tabIndexOf } = useRoving(points.length);
  const chartRef = useRef<HTMLDivElement>(null);
  const [labelEvery, setLabelEvery] = useState(1);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const measure = () => {
      const labels = Array.from(chart.querySelectorAll<HTMLElement>(".dash-bar-time"));
      const widestRatio = labels.reduce(
        (ratio, label) => Math.max(ratio, label.scrollWidth / Math.max(1, label.clientWidth)),
        1
      );
      const next = Math.max(1, Math.ceil(widestRatio));
      setLabelEvery((current) => (current === next ? current : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(chart);
    measure();
    return () => ro.disconnect();
  }, [points]);
  // a stacked column is as tall as its own total, so the axis has to measure
  // totals — otherwise the tallest stack overflows the plot
  const totals = bands
    ? points.map((_, i) => bands.reduce((s, b) => s + (b.points[i]?.value ?? 0), 0))
    : points.map((p) => p.value);
  const max = Math.max(0, ...totals);
  const showVals = points.length <= 12;
  const showLabel = (i: number) =>
    i === 0 || i === points.length - 1 || (i % labelEvery === 0 && points.length - 1 - i >= labelEvery);
  /** One empty-bucket reading for both shapes (SUB-954): a bucket with no rows
      behind it — a zero-filled gap in a date axis, split or not — carries no
      tooltip rows, so it says "no rows" and wears the empty treatment. A
      bucket whose real rows happen to sum to zero is NOT empty and keeps its
      own value reading. */
  const rowsAt = (i: number): TipRow[] =>
    bands
      ? bands
          .map((b, bi) => ({ name: b.name, band: bi, value: b.points[i]?.value ?? 0, n: b.points[i]?.n ?? 0 }))
          .filter((r) => r.n > 0)
      : points[i].n > 0
        ? [{ name: null, band: 0, value: points[i].value, n: points[i].n }]
        : [];
  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="dash-chart" ref={chartRef}>
        {points.map((p, i) => {
          const rows = rowsAt(i);
          const empty = rows.length === 0;
          const total = totals[i];
          // A real split bucket can contain rows whose values are all zero.
          // It is not empty, but it has no positive slice to paint, so the
          // stack itself carries the same honest zero mark as a plain bar.
          const zero = !empty && total === 0;
          const h = max > 0 ? Math.max(3, (total / max) * 120) : 3;
          const valueLabel = showVals && total !== 0 && h >= 18 ? fmtVal(total) : "";
          const tint = !bands && !empty
            ? xOptions?.length
              ? optionColorVar(optionColor(xOptions, p.label))
              : categorical
                ? SERIES_RAMP[i % SERIES_RAMP.length]
                : undefined
            : undefined;
          // schema hues are saturated dot colours and get the pill's dose; the
          // series ramp is already tuned to bar weight on both grounds.
          const style = (
            tint
              ? xOptions?.length
              ? {
                  height: h,
                  "--bar": `color-mix(in srgb, ${tint} 55%, transparent)`,
                  "--bar-hover": `color-mix(in srgb, ${tint} 72%, transparent)`,
                }
                : {
                    height: h,
                    "--bar": tint,
                    "--bar-hover": `color-mix(in srgb, ${tint} 78%, #fff)`,
                  }
              : { height: h }
          ) as CSSProperties;
          const onEnter = (e: { currentTarget: Element }) =>
            show(e.currentTarget.querySelector(".dash-bar"), p.label, rows);
          return (
            <div
              className="dash-bar-col"
              key={p.key}
              ref={(el) => {
                slots.current[i] = el;
              }}
              tabIndex={tabIndexOf(i)}
              role="button"
              aria-label={tipText(p.label, rows)}
              onMouseEnter={onEnter}
              onMouseLeave={hide}
              onFocus={onEnter}
              onBlur={hide}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {/* an empty bucket is already said by the baseline tick — the "0"
                  label on top of it is the same statement twice (SUB-527) */}
              <span className="dash-bar-val" title={valueLabel || undefined}>
                {valueLabel}
              </span>
              {bands ? (
                // the whole stack is one bar-height box; the slices divide it by
                // share, so a column reads as one mark and the totals compare
                <div
                  className={`dash-bar is-stack${empty ? " is-empty" : zero ? " is-zero" : ""}`}
                  style={{ height: h }}
                >
                  {bands.map((b, bi) => {
                    const v = b.points[i]?.value ?? 0;
                    if (v <= 0) return null;
                    return (
                      <div
                        className={`dash-bar-slice ${bandClass(bi)}`}
                        key={b.name}
                        style={{ flexGrow: v }}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className={`dash-bar${empty ? " is-empty" : ""}`} style={style} />
              )}
              <span
                className={`dash-bar-time${showLabel(i) ? "" : " is-hidden"}`}
                title={p.label}
                aria-hidden="true"
              >
                {p.label}
              </span>
            </div>
          );
        })}
      </div>
      <ChartTip tip={tip} />
    </div>
  );
}

/** label thinning: never let two kept labels land closer than this */
const MIN_LABEL_PX = 56;
/** stand-in plot width for the first frame, before the ResizeObserver fires */
const LABEL_FALLBACK_PX = 560;

/** Line chart in the same language: greyscale stroke + dots (HTML, so they
    stay round at any width), tooltip per point, labels below at each kept
    point's true x. X is time-true (xFractions): irregular snapshots space by
    their real date gaps, categorical axes keep even index spacing. The plot
    insets right of a fixed 40px gutter that holds the hi/lo value hints at
    their y positions; a baseline runs under the whole chart. */
function LineChart({ points, bands }: { points: ChartPoint[]; bands?: ChartBand[] | null }) {
  const { wrapRef, tip, show, hide } = useChartTip();
  const { slots, onKeyDown, tabIndexOf } = useRoving(points.length);
  // `points` is the shared axis even when split: every band's keys are a subset
  // of it (lib/chart.ts builds bands from the final axis), so a band's point at
  // key k lands at the same x as every other band's.
  const vals = bands ? bands.flatMap((b) => b.points.map((p) => p.value)) : points.map((p) => p.value);
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  const pad = (hi0 - lo0) * 0.1 || 1;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const n = points.length;
  const fx = xFractions(points.map((p) => p.key));
  const px = (i: number) => 2 + fx[i] * 96;
  const py = (v: number) => 92 - ((v - lo) / (hi - lo)) * 84;
  // hi/lo value hints — both pinned in the left gutter, never floating per side
  const hints: { v: number; y: number }[] = [{ v: hi0, y: py(hi0) }];
  if (lo0 !== hi0) hints.push({ v: lo0, y: py(lo0) });

  // Labels ride the same fractions, absolutely positioned under their dots.
  // Thinning is by PROXIMITY: a label is dropped when it would land within
  // MIN_LABEL_PX of the previously kept one — distances are fractions × the
  // live label-row width (= the plot width), measured via ResizeObserver;
  // FALLBACK_PX only covers the first frame before the observer fires. First
  // and last always stay, clamped to the row's edges; a cramped last label
  // swaps out the previous one (the gap to the label before only grows, so
  // the minimum distance still holds).
  const labelsRef = useRef<HTMLDivElement>(null);
  const [labelW, setLabelW] = useState(0);
  useEffect(() => {
    const el = labelsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLabelW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const w = labelW || LABEL_FALLBACK_PX;
  const kept: number[] = [0];
  for (let i = 1; i < n; i++) {
    if ((fx[i] - fx[kept[kept.length - 1]]) * w >= MIN_LABEL_PX) kept.push(i);
  }
  if (n > 1 && kept[kept.length - 1] !== n - 1) {
    // a two-point chart keeps both ends, as the old slot scheme did
    if (kept.length === 1) kept.push(n - 1);
    else kept[kept.length - 1] = n - 1;
  }
  const labelStyle = (i: number): CSSProperties => {
    if (i === 0) return { left: 0 };
    if (i === n - 1) return { left: "100%", transform: "translateX(-100%)" };
    return { left: `${px(i)}%`, transform: "translateX(-50%)" };
  };
  const slotStyle = (i: number): CSSProperties => {
    const here = px(i);
    const left = i === 0 ? 0 : (px(i - 1) + here) / 2;
    const right = i === n - 1 ? 100 : (here + px(i + 1)) / 2;
    return { left: `${left}%`, width: `${right - left}%` };
  };

  // a band skips x keys it has no rows for, so its dots index by key
  const at = new Map(points.map((p, i) => [p.key, i]));
  const lines = bands
    ? bands.map((b) => b.points.map((p) => ({ p, i: at.get(p.key) ?? 0 })))
    : [points.map((p, i) => ({ p, i }))];
  // `aggregate()` rebuilds `bands` whenever the parent renders, so memoizing
  // this index by array identity cannot cache it across those renders. Build
  // the O(bands × points) index once per render instead; then the two readings
  // for every slot use O(1) key lookups rather than rescanning each band and
  // making the render quadratic in the number of points (SUB-954).
  const bandAt = bands?.map((b) => new Map(b.points.map((p) => [p.key, p]))) ?? null;
  const rowsAt = (i: number): TipRow[] => {
    const p = points[i];
    if (!bands || !bandAt) return p.n > 0 ? [{ name: null, band: 0, value: p.value, n: p.n }] : [];
    const out: TipRow[] = [];
    bands.forEach((b, bi) => {
      const hit = bandAt[bi].get(p.key);
      if (hit) out.push({ name: b.name, band: bi, value: hit.value, n: hit.n });
    });
    return out;
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="chart-line">
        <div className="chart-line-plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {lines.map((line, bi) => (
              <polyline
                key={bi}
                className={`chart-line-path ${bands ? bandClass(bi) : ""}`}
                fill="none"
                vectorEffect="non-scaling-stroke"
                points={line.map(({ p, i }) => `${px(i)},${py(p.value)}`).join(" ")}
              />
            ))}
          </svg>
          {lines.map((line, bi) =>
            line.map(({ p, i }) => (
              <span
                key={`${bi}-${p.key}`}
                className={`chart-dot ${bands ? bandClass(bi) : ""}`}
                style={{ left: `${px(i)}%`, top: `${py(p.value)}%` }}
                aria-hidden="true"
              />
            ))
          )}
          {/* one invisible full-height slot per x, so hover and focus land on
              the column rather than on a 5px dot — and a split chart reads all
              its bands at that x in one card */}
          {points.map((p, i) => {
            const onEnter = (e: { currentTarget: Element }) => show(e.currentTarget, p.label, rowsAt(i));
            return (
              <span
                key={p.key}
                className="chart-line-slot"
                style={slotStyle(i)}
                ref={(el) => {
                  slots.current[i] = el;
                }}
                tabIndex={tabIndexOf(i)}
                role="button"
                aria-label={tipText(p.label, rowsAt(i))}
                onMouseEnter={onEnter}
                onMouseLeave={hide}
                onFocus={onEnter}
                onBlur={hide}
                onKeyDown={(e) => onKeyDown(e, i)}
              />
            );
          })}
        </div>
        {hints.map((h) => (
          <span key={`hint-${h.v}`} className="chart-line-hint" style={{ top: `${h.y}%` }}>
            {fmtVal(h.v)}
          </span>
        ))}
      </div>
      <ChartTip tip={tip} />
      <div className="chart-line-labels" ref={labelsRef}>
        {kept.map((i) => (
          <span key={points[i].key} style={labelStyle(i)}>
            {points[i].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChartSection({
  block,
  series,
  loadError,
  xOptions,
}: {
  block: ChartBlock;
  series: ChartSeries | null;
  loadError: string | null;
  /** schema options of a db-sourced categorical x prop — bars wear their hues */
  xOptions?: SelectOption[];
}) {
  if (block.error || !block.config) {
    return (
      <div>
        <div className="dash-section-label">Chart block</div>
        <div className="chart-err">{block.error ?? "invalid chart block"}</div>
      </div>
    );
  }
  const c = block.config;
  const splitError =
    series?.bands && series.bands.length > BAND_TREATMENTS
      ? `This split has ${series.bands.length} series; the current grayscale chart can distinguish ${BAND_TREATMENTS}.`
      : c.kind === "bar" && series?.bands?.some((band) => band.points.some((p) => p.value < 0))
        ? "Stacked bars cannot represent negative split values — use kind: line."
        : null;
  return (
    <div>
      <div className="dash-section-label">{chartTitle(c)}</div>
      {loadError ? (
        <div className="chart-err">{loadError}</div>
      ) : series === null ? (
        <div className="dash-foot" style={{ margin: "4px 0 0" }}>
          …
        </div>
      ) : series.missing ? (
        // a bound property that exists nowhere in the source is a named error,
        // like a LOOKUP miss or a `series:` binding to a non-summary — "check
        // the property names" is the app knowing the answer and not saying it
        // (SUB-749). A renamed column lands here; genuine zero-match below.
        <div className="chart-err">{series.missing}</div>
      ) : splitError ? (
        <div className="chart-err">{splitError}</div>
      ) : series.points.length === 0 ? (
        <div className="dash-foot" style={{ margin: "4px 0 0" }}>
          No rows matched — check the source and property names.
        </div>
      ) : (
        <>
          {/* the legend sits above the plot: it names what the marks mean, so
              it has to be read before them, not after */}
          {series.bands && series.bands.length > 0 ? <ChartLegend bands={series.bands} /> : null}
          {c.kind === "line" ? (
            <LineChart points={series.points} bands={series.bands} />
          ) : (
            <BarChart
              points={series.points}
              bands={series.bands}
              xOptions={xOptions}
              categorical={c.bind === "summaries" || c.x.bucket === null}
            />
          )}
        </>
      )}
      <div className="dash-foot" style={{ margin: "10px 0 0" }}>
        {chartSourceDesc(c)} · {series?.points.length ?? 0}{" "}
        {series && series.points.length === 1 ? "point" : "points"}
        {series && series.skipped > 0 ? ` · ${series.skipped} rows skipped` : ""}
      </div>
    </div>
  );
}

export default function ChartsDashboard({
  meta,
  notes,
  body,
  vaultEpoch,
  schema,
  onOpenSource,
  embed,
  configOverride,
}: ChartsDashboardProps) {
  // one table, one resolver (SUB-834); the footer's single pair is derived
  const { fx: rates } = useFxRates();
  const fx = useMemo(() => usdEurFrom(rates), [rates]);
  const [sheets, setSheets] = useState<Map<string, DashboardSheetState>>(new Map());
  // SUB-1001: the last chart's title used to cut in half against the pane's
  // bottom edge with nothing marking the overflow. Declared above the `embed`
  // branch below — hooks can't sit behind a conditional return.
  const fade = useEdgeFade<HTMLDivElement>();

  const blocks = useMemo<ChartBlock[]>(
    () => configOverride ? [{ config: configOverride, error: null }] : parseChartBlocks(body),
    [body, configOverride]
  );
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of blocks) {
      const s = b.config?.source;
      if (s?.kind === "sheet") seen.set(s.name.toLowerCase(), s.name);
    }
    return [...seen.values()];
  }, [blocks]);

  // Load every charted sheet — and transitively any sheet its formulas
  // reference — then evaluate each with the cross-sheet loader (SUB-671).
  // Without the loader a computed column reading another sheet evaluated to an
  // error in every cell, which the chart then skipped or stringified. The
  // epoch/rate cache shares the same work across composed dashboard tiles.
  useEffect(() => {
    let gone = false;
    dashboardSheets(sheetNames, vaultEpoch, rates)
      .then((next) => {
        if (!gone) setSheets(next);
      })
      // a rejected pass (evicted from the cache) surfaces as a per-sheet
      // error instead of leaving every chart loading forever
      .catch((error) => {
        if (gone) return;
        const msg = error instanceof Error ? error.message : String(error);
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

  const seriesFor = (
    block: ChartBlock,
  ): { series: ChartSeries | null; loadError: string | null; xOptions?: SelectOption[] } => {
    const c = block.config;
    if (!c) return { series: null, loadError: null };
    if (c.bind === "summaries") {
      // parsing rejects a non-sheet source for `series`, so this always reads a
      // sheet
      const state = c.source.kind === "sheet" ? sheets.get(c.source.name.toLowerCase()) : undefined;
      if (!state) return { series: null, loadError: null };
      if ("error" in state) return { series: null, loadError: state.error };
      // a named summary that doesn't resolve is a chart-level error, not an
      // empty plot: the fence names its points, so a missing one has to say so
      const { series, error } = summarySeries(state.ev, c.series);
      return { series, loadError: error };
    }
    if (c.source.kind === "db") {
      const opts = xSchemaOptions(schema, c.source.type, c.x.prop);
      return {
        series: aggregate(dbRows(notes, c.source.type), c, opts),
        loadError: null,
        // hues only where color already means something: a select-kind x prop
        // with schema'd options (date axes and unschema'd props carry none)
        xOptions: opts?.length ? opts : undefined,
      };
    }
    const state = sheets.get(c.source.name.toLowerCase());
    if (!state) return { series: null, loadError: null };
    if ("error" in state) return { series: null, loadError: state.error };
    return { series: aggregate(sheetRows(state.model, state.ev), c), loadError: null };
  };

  if (embed) {
    return (
      <>
        {blocks.map((b, i) => {
          const { series, loadError, xOptions } = seriesFor(b);
          return (
            <ChartSection key={i} block={b} series={series} loadError={loadError} xOptions={xOptions} />
          );
        })}
      </>
    );
  }

  return (
    <div className={`note${fade.className}`} {...fade.props}>
      <div className="dash-inner">
        <DashHead
          title={meta.title}
          state={{
            label:
              `${blocks.length} ${blocks.length === 1 ? "chart" : "charts"}` +
              (sheetNames.length > 0
                ? ` · ${sheetNames.length} ${sheetNames.length === 1 ? "sheet" : "sheets"}`
                : ""),
          }}
          actions={<DashPrintButton />}
          sourcePath={meta.path}
          onOpenSource={onOpenSource}
        />

        {blocks.map((b, i) => {
          const { series, loadError, xOptions } = seriesFor(b);
          return (
            <ChartSection key={i} block={b} series={series} loadError={loadError} xOptions={xOptions} />
          );
        })}

        <div className="dash-foot">
          Charts are chart fences in this note — edit the text to reconfigure them.
          {fx ? ` USD→EUR ${fmtFx(fx.usdEur)}${fx.live ? "" : " (cached)"} for FX columns.` : ""}
        </div>
      </div>
    </div>
  );
}
