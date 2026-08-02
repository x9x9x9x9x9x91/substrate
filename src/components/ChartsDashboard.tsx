import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { NoteMeta, SchemaConfig, SelectOption } from "../lib/types";
import { propStr } from "../lib/types";
import { vaultRead, vaultResolve } from "../lib/ipc";
import { fmtFx } from "../lib/dashboard";
import { useUsdEur } from "./useFx";
import { evaluateSheet, parseSheet, type SheetEval, type SheetModel } from "../lib/sheet";
import { collectCrossRefs, ferr, isErr, type FErr, type FxResolver } from "../lib/formula";
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
  type ChartBlock,
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
}

type SheetState = { model: SheetModel; ev: SheetEval } | { error: string };

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

function tooltip(p: ChartPoint): string {
  return `${p.label} · ${fmtFull(p.value)}${p.n > 1 ? ` · ${p.n} rows` : ""}`;
}

/** Bar chart in the dashboard idiom: flat columns, value on top, label below,
    tooltip on hover. When the categorical x axis is a select prop with schema
    colors (xOptions), each bar wears its option's hue at the pill's color-mix
    dose; uncolored values stay neutral. Values and labels thin out when
    crowded. */
function BarChart({ points, xOptions }: { points: ChartPoint[]; xOptions?: SelectOption[] }) {
  const max = Math.max(0, ...points.map((p) => p.value));
  const showVals = points.length <= 12;
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  return (
    <div className="dash-chart">
      {points.map((p, i) => {
        const h = max > 0 ? Math.max(3, (p.value / max) * 120) : 3;
        const tint = xOptions?.length ? optionColorVar(optionColor(xOptions, p.label)) : undefined;
        const style = (
          tint
            ? {
                height: h,
                "--bar": `color-mix(in srgb, ${tint} 55%, transparent)`,
                "--bar-hover": `color-mix(in srgb, ${tint} 72%, transparent)`,
              }
            : { height: h }
        ) as CSSProperties;
        return (
          <div className="dash-bar-col" key={p.key} title={tooltip(p)}>
            {/* an empty bucket is already said by the baseline tick — the "0"
                label on top of it is the same statement twice (SUB-527) */}
            <span className="dash-bar-val">
              {showVals && p.value !== 0 ? fmtVal(p.value) : ""}
            </span>
            <div className="dash-bar" style={style} />
            <span className="dash-bar-time">
              {i % labelEvery === 0 || i === points.length - 1 ? p.label : ""}
            </span>
          </div>
        );
      })}
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
function LineChart({ points }: { points: ChartPoint[] }) {
  const vals = points.map((p) => p.value);
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

  return (
    <>
      <div className="chart-line">
        <div className="chart-line-plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline
              className="chart-line-path"
              fill="none"
              vectorEffect="non-scaling-stroke"
              points={points.map((p, i) => `${px(i)},${py(p.value)}`).join(" ")}
            />
          </svg>
          {points.map((p, i) => (
            <span
              key={p.key}
              className="chart-dot"
              style={{ left: `${px(i)}%`, top: `${py(p.value)}%` }}
              title={tooltip(p)}
            />
          ))}
        </div>
        {hints.map((h) => (
          <span key={`hint-${h.v}`} className="chart-line-hint" style={{ top: `${h.y}%` }}>
            {fmtVal(h.v)}
          </span>
        ))}
      </div>
      <div className="chart-line-labels" ref={labelsRef}>
        {kept.map((i) => (
          <span key={points[i].key} style={labelStyle(i)}>
            {points[i].label}
          </span>
        ))}
      </div>
    </>
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
      ) : series.points.length === 0 ? (
        <div className="dash-foot" style={{ margin: "4px 0 0" }}>
          No rows matched — check the source and property names.
        </div>
      ) : c.kind === "line" ? (
        <LineChart points={series.points} />
      ) : (
        <BarChart points={series.points} xOptions={xOptions} />
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
}: ChartsDashboardProps) {
  const { fx } = useUsdEur();
  const [sheets, setSheets] = useState<Map<string, SheetState>>(new Map());

  const blocks = useMemo(() => parseChartBlocks(body), [body]);
  const sheetNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const b of blocks) {
      const s = b.config?.source;
      if (s?.kind === "sheet") seen.set(s.name.toLowerCase(), s.name);
    }
    return [...seen.values()];
  }, [blocks]);

  const fxResolver: FxResolver = (from, to) => {
    if (!fx) return null;
    if (from === "USD" && to === "EUR") return fx.usdEur;
    if (from === "EUR" && to === "USD") return 1 / fx.usdEur;
    return null;
  };

  // Load every charted sheet — and transitively any sheet its formulas
  // reference — then evaluate each with the cross-sheet loader (SUB-671).
  // Without the loader a computed column reading another sheet evaluated to an
  // error in every cell, which the chart then skipped or stringified.
  useEffect(() => {
    let gone = false;
    (async () => {
      const models = new Map<string, SheetModel | FErr>();
      const queue = [...sheetNames];
      const queued = new Set(queue.map((n) => n.toLowerCase()));
      while (queue.length > 0) {
        const name = queue.shift()!;
        try {
          const resolved = await vaultResolve(name);
          if (!resolved) {
            models.set(name.toLowerCase(), ferr(`no note named “${name}”`));
            continue;
          }
          if (propStr(resolved.props, "type") !== "sheet") {
            models.set(name.toLowerCase(), ferr(`“${name}” is not a sheet`));
            continue;
          }
          const content = await vaultRead(resolved.path);
          const m = parseSheet(content.body);
          models.set(name.toLowerCase(), m);
          for (const f of m.formulas) {
            if (isErr(f.expr)) continue;
            for (const cr of collectCrossRefs(f.expr)) {
              if (!queued.has(cr.sheet)) {
                queued.add(cr.sheet);
                queue.push(cr.sheet);
              }
            }
          }
        } catch (e) {
          models.set(name.toLowerCase(), ferr(String(e)));
        }
      }
      if (gone) return;
      const load = (name: string) =>
        models.get(name.toLowerCase()) ?? ferr(`no sheet named “${name}”`);
      const next = new Map<string, SheetState>();
      for (const name of sheetNames) {
        const m = models.get(name.toLowerCase());
        if (!m || isErr(m)) {
          next.set(name.toLowerCase(), { error: m ? m.err : "not loaded" });
          continue;
        }
        next.set(name.toLowerCase(), {
          model: m,
          ev: evaluateSheet(m, fxResolver, { self: name, load }),
        });
      }
      setSheets(next);
    })();
    // the flag exists to drop a stale pass; without this cleanup it never
    // flipped, so a slow earlier load could overwrite a newer one
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.path, vaultEpoch, sheetNames.join("|"), fx]);

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
    <div className="note">
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
