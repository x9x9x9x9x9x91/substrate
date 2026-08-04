/** The goal thermometer (SUB-967). A ```progress fence puts one number against
    the number it is supposed to reach inside the universal hub canvas. A hub
    body containing one fence is the standalone form; no separate dashboard
    kind or dispatch surface is introduced.

    Parsing, counting and pace live in src/lib/progress.ts; sheet loading is
    the metric card's own loader (useSheetStates), so a bound summary resolves
    the same way here as it does on a card. */

import { useMemo, type CSSProperties } from "react";
import type { NoteMeta, SchemaConfig } from "../lib/types";
import { useFxRates } from "./useFx";
import { isErr } from "../lib/formula";
import { fmtCard } from "../lib/metriccards";
import {
  paceText,
  parseProgressBlocks,
  progressCount,
  progressFraction,
  progressLabel,
  progressPace,
  progressPercent,
  progressSheets,
  type ProgressBlock,
  type ProgressConfig,
} from "../lib/progress";
import { readBind, useSheetStates, type SheetState } from "./MetricCards";
import { useTodayIso } from "./useTodayIso";

interface ProgressDashboardProps {
  meta: NoteMeta;
  notes: NoteMeta[];
  body: string;
  vaultEpoch: number;
  schema: SchemaConfig;
}

/** A resolved side of the thermometer: a number, or the reason there isn't
    one. `null` on both means the sheets are still loading. */
type Resolved = { n: number | null; error: string | null };

const LOADING: Resolved = { n: null, error: null };

function resolveBind(sheets: Map<string, SheetState>, bind: string): Resolved {
  const r = readBind(sheets, bind);
  if (r.loading) return LOADING;
  if (r.value === null) return { n: null, error: r.miss ?? r.title ?? `can't read ${bind}` };
  if (isErr(r.value)) return { n: null, error: r.value.err };
  if (typeof r.value !== "number") return { n: null, error: `${bind} is not a number` };
  return { n: r.value, error: null };
}

function ProgressSection({
  block,
  value,
  target,
  today,
}: {
  block: ProgressBlock;
  value: Resolved;
  target: Resolved;
  today: string;
}) {
  // a broken fence says so where it stands and leaves its siblings alone
  if (block.error || !block.config) {
    return (
      <div className="progress-fence">
        <div className="dash-section-label">Progress block</div>
        <div className="progress-err">{block.error ?? "invalid progress block"}</div>
      </div>
    );
  }
  const c: ProgressConfig = block.config;
  const label = progressLabel(c);
  const err = value.error ?? target.error;
  const loading = err === null && (value.n === null || target.n === null);

  const head = (
    <div className="progress-head">
      <span className="dash-label">{label}</span>
      {value.n !== null && target.n !== null && (
        <span className="progress-pct">{progressPercent(value.n, target.n)}%</span>
      )}
    </div>
  );

  if (err !== null) {
    return (
      <div className="progress-fence">
        {head}
        <div className="progress-err">{err}</div>
      </div>
    );
  }
  if (loading || value.n === null || target.n === null) {
    return (
      <div className="progress-fence">
        {head}
        <div className="progress-foot">…</div>
      </div>
    );
  }

  const fraction = progressFraction(value.n, target.n);
  const reading = `${fmtCard(value.n, c.format, c.digits)} of ${fmtCard(target.n, c.format, c.digits)}`;
  const pace =
    c.deadline === null
      ? null
      : paceText(progressPace(value.n, target.n, c.deadline, c.start, today), c.format, c.digits);

  return (
    <div className="progress-fence">
      {head}
      {/* the bar is a picture of the number beside it — the text is the
          accessible reading, so the track itself is aria-hidden and the
          progressbar role sits on the row that carries both */}
      <div
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={target.n}
        aria-valuenow={value.n}
        aria-valuetext={`${reading}${pace ? ` · ${pace}` : ""}`}
      >
        <span
          className="progress-fill"
          style={{ "--progress-fill": `${fraction * 100}%` } as CSSProperties}
        />
      </div>
      <div className="progress-read">{reading}</div>
      {pace && <div className="progress-foot">{pace}</div>}
    </div>
  );
}

export default function ProgressDashboard({
  meta,
  notes,
  body,
  vaultEpoch,
  schema,
}: ProgressDashboardProps) {
  const today = useTodayIso();
  const blocks = useMemo(() => parseProgressBlocks(body), [body]);
  const configs = useMemo(
    () => blocks.map((b) => b.config).filter((c): c is ProgressConfig => c !== null),
    [blocks],
  );
  const sheetNames = useMemo(() => progressSheets(configs), [configs]);
  // the same quoted rate table the cards read (SUB-834): a bound summary must
  // convert identically on a thermometer and on a card
  const { fx: rates } = useFxRates();
  const sheets = useSheetStates(sheetNames, vaultEpoch, meta.path, rates);

  const valueOf = (c: ProgressConfig): Resolved => {
    if (c.value.kind === "bind") return resolveBind(sheets, c.value.bind);
    const r = progressCount(c, notes, schema);
    return "error" in r ? { n: null, error: r.error } : { n: r.count, error: null };
  };
  const targetOf = (c: ProgressConfig): Resolved =>
    c.target.kind === "number" ? { n: c.target.n, error: null } : resolveBind(sheets, c.target.bind);

  const sections = blocks.map((b, i) => (
    <ProgressSection
      key={i}
      block={b}
      value={b.config ? valueOf(b.config) : LOADING}
      target={b.config ? targetOf(b.config) : LOADING}
      today={today}
    />
  ));

  return <>{sections}</>;
}
