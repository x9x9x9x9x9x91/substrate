import { daysInMonth, formatDateHuman, isIsoDate } from "./dates.ts";
import { findFence } from "./sheet.ts";
import { byFoldedKey } from "./schemalookup.ts";

export interface Snapshot {
  at: Date;
  atRaw: string;
  yieldUsd: number;
  principalUsd: number;
}

/** Snapshot timestamps are LOCAL wall-clock whether the row carries a time or
    not (SUB-233): parsed from explicit components like dates.ts does, because
    `new Date("YYYY-MM-DD")` reads a bare date as UTC while a datetime reads
    local — mixing the two skews intervals by the TZ offset and can invert
    the sort. */
export function parseAt(raw: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw.trim());
  if (!m) return new Date(NaN);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const s = Number(m[6] ?? 0);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) {
    return new Date(NaN);
  }
  return new Date(y, mo - 1, d, h, mi, s);
}

export interface Interval {
  start: Snapshot;
  end: Snapshot;
  minutes: number;
  gainUsd: number;
  ratePerMin: number;
  apr: number | null;
}

export interface YieldStats {
  aprSteady: number | null;
  aprOverall: number | null;
  ratePerMin: number | null;
  perDayUsd: number | null;
  perWeekUsd: number | null;
  perMonthUsd: number | null;
  perYearUsd: number | null;
  principalUsd: number | null;
  totalYieldUsd: number;
  accruedSinceFirstUsd: number;
  windowMinutes: number;
  stabilityCv: number | null;
  stateLabel: "steady" | "wobbly" | "unstable" | "no data";
}

const MIN_PER_YEAR = 365 * 24 * 60;

export function parseSnapshotsFromBody(body: string): { snapshots: Snapshot[]; fence: { from: number; to: number } | null } {
  /** The shared quote-aware finder (SUB-277): the old lazy regex missed CRLF
      fences entirely and ended the fence early on a ``` inside a quoted cell,
      which made fence.to point into row data and corrupted appends. */
  const csv = findFence(body, "csv");
  if (!csv) return { snapshots: [], fence: null };
  const snapshots: Snapshot[] = [];
  for (const line of csv.inner.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("at,")) continue;
    const parts = t.split(",");
    if (parts.length < 3) continue;
    const at = parseAt(parts[0]);
    const yieldUsd = parseFloat(parts[1]);
    const principalUsd = parseFloat(parts[2]);
    if (isNaN(at.getTime()) || isNaN(yieldUsd) || isNaN(principalUsd)) continue;
    snapshots.push({ at, atRaw: parts[0], yieldUsd, principalUsd });
  }
  snapshots.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { snapshots, fence: { from: csv.from, to: csv.to } };
}

export function fmtAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Snapshot timestamp for display (SUB-250): the date shaped like note chips
    (dates.ts formatDateHuman, "Jul 17, 2026"); when the raw carries a clock
    time the year is dropped and the time appended — "2026-07-17 14:18" →
    "Jul 17, 14:18". Non-ISO raws pass through untouched. */
export function fmtAtHuman(atRaw: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?)?$/.exec(atRaw.trim());
  if (!m || !isIsoDate(m[1])) return atRaw;
  const day = formatDateHuman(m[1]);
  if (!m[2]) return day;
  return `${day.replace(/, \d{4}$/, "")}, ${m[2]}`;
}

export function appendSnapshotToBody(body: string, s: { atRaw: string; yieldUsd: number; principalUsd: number }): string {
  const row = `${s.atRaw},${s.yieldUsd},${s.principalUsd}`;
  const { fence } = parseSnapshotsFromBody(body);
  if (!fence) {
    const block = `\n\`\`\`csv\nat,yield_usd,principal_usd\n${row}\n\`\`\`\n`;
    return body.trimEnd() + "\n" + block;
  }
  const inner = body.slice(fence.from, fence.to);
  // the closing fence may hug the last row (no trailing newline) — splice the
  // new row in either way instead of silently no-opping (SUB-231)
  const updated = inner.endsWith("\n```")
    ? inner.replace(/\n```$/, `\n${row}\n\`\`\``)
    : inner.replace(/```$/, `\n${row}\n\`\`\``);
  return body.slice(0, fence.from) + updated + body.slice(fence.to);
}

/** Cumulative claimed yield (SUB-318): claiming at the venue resets its
    displayed balance, but the snapshot series must not reset — csv rows stay
    cumulative (claimed + live venue balance) so interval/APR math never sees
    the withdrawal. The running claimed total lives on the note as a
    `claimed_usd` prop; the log form adds it to entered venue balances. */
export function readClaimedUsd(props: Record<string, unknown>): number {
  const raw = byFoldedKey(props, "claimed_usd");
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  return isFinite(n) && n > 0 ? n : 0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeIntervals(snapshots: Snapshot[]): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const start = snapshots[i - 1];
    const end = snapshots[i];
    const minutes = (end.at.getTime() - start.at.getTime()) / 60000;
    if (minutes <= 0) continue;
    const gainUsd = end.yieldUsd - start.yieldUsd;
    const ratePerMin = gainUsd / minutes;
    const apr = end.principalUsd > 0 ? (ratePerMin * MIN_PER_YEAR * 100) / end.principalUsd : null;
    out.push({ start, end, minutes, gainUsd, ratePerMin, apr });
  }
  return out;
}

export function computeStats(snapshots: Snapshot[], intervals: Interval[]): YieldStats {
  if (snapshots.length < 2) {
    return {
      aprSteady: null,
      aprOverall: null,
      ratePerMin: null,
      perDayUsd: null,
      perWeekUsd: null,
      perMonthUsd: null,
      perYearUsd: null,
      principalUsd: snapshots[0]?.principalUsd ?? null,
      totalYieldUsd: snapshots[0]?.yieldUsd ?? 0,
      accruedSinceFirstUsd: 0,
      windowMinutes: 0,
      stabilityCv: null,
      stateLabel: "no data",
    };
  }
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const windowMinutes = (last.at.getTime() - first.at.getTime()) / 60000;
  const principalUsd = last.principalUsd;
  const overallRate = windowMinutes > 0 ? (last.yieldUsd - first.yieldUsd) / windowMinutes : 0;
  const aprOverall = principalUsd > 0 ? (overallRate * MIN_PER_YEAR * 100) / principalUsd : null;

  const rates = intervals.map((iv) => iv.ratePerMin);
  const med = median(rates);
  const mad = median(rates.map((r) => Math.abs(r - med)));
  const kept = mad === 0 ? intervals : intervals.filter((iv) => Math.abs(iv.ratePerMin - med) <= 3 * mad);
  const keptMin = kept.reduce((s, iv) => s + iv.minutes, 0);
  const keptGain = kept.reduce((s, iv) => s + iv.gainUsd, 0);
  const steadyRate = keptMin > 0 ? keptGain / keptMin : overallRate;
  const aprSteady = principalUsd > 0 ? (steadyRate * MIN_PER_YEAR * 100) / principalUsd : null;

  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length;
  const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : null;
  const stateLabel = cv === null ? "no data" : cv <= 0.4 ? "steady" : cv <= 1 ? "wobbly" : "unstable";

  return {
    aprSteady,
    aprOverall,
    ratePerMin: steadyRate,
    perDayUsd: steadyRate * 60 * 24,
    perWeekUsd: steadyRate * 60 * 24 * 7,
    perMonthUsd: (steadyRate * MIN_PER_YEAR) / 12,
    perYearUsd: steadyRate * MIN_PER_YEAR,
    principalUsd,
    totalYieldUsd: last.yieldUsd,
    accruedSinceFirstUsd: last.yieldUsd - first.yieldUsd,
    windowMinutes,
    stabilityCv: cv,
    stateLabel,
  };
}

export interface FxRate {
  usdEur: number;
  asOf: string;
  live: boolean;
}

/* The live FX read moved to the engine (SUB-667): the shipped CSP allows no
   remote origin, so the browser fetch that used to live here was blocked in
   the packaged app. It is now `fxUsdEur` in lib/ipc.ts, called from useFx. */

/** Money on dashboards (SUB-245): the app's de-DE dialect (SUB-196) —
    German grouping ("1.234,56") with the symbol trailing after a space,
    same as euro cells render. */
export function fmtMoney(n: number | null, currency: "€" | "$", digits = 0): string {
  if (n === null || !isFinite(n)) return "—";
  return (
    n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }) +
    " " +
    currency
  );
}

/** FX rate wherever it's quoted (SUB-282): de-DE like fmtMoney, always
    4 decimals ("0,8642") — a quote, not money, so no symbol attached. */
export function fmtFx(rate: number): string {
  return rate.toLocaleString("de-DE", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** Design principle 11 — at most two sharp values per dashboard. Emphasis is
    data (`emph: true` on a metrics card), never position: the flagged cards
    win in card order, extras beyond the cap sink, and a board that flags
    nothing still gets one anchor (its first card). Returns the indices that
    keep the sharp voice. */
export function sharpCardIndices(cards: { emph?: boolean }[]): Set<number> {
  const flagged = cards.map((c, i) => (c.emph ? i : -1)).filter((i) => i >= 0);
  if (flagged.length === 0) return new Set(cards.length > 0 ? [0] : []);
  return new Set(flagged.slice(0, 2));
}

/** Column count for a metrics board's card strip (SUB-625). One row of N
    tiles pinned to the top of a wide pane reads as a ticker, not a board:
    seven cards at 1900px occupied the top ~15% and left the rest empty. The
    strip becomes a block instead — at most four columns, and the count is
    chosen so the rows come out even, because a last row holding a single
    orphan tile reads as a broken grid (the same reason the old auto-fit
    minimum was tightened to 116px). 7 → 4 (4+3), 5 → 3 (3+2), 9 → 3 (3+3+3).
    Boards that can't avoid an orphan at any count keep the widest strip. */
export function metricsColumns(count: number): number {
  if (count <= 4) return Math.max(count, 1);
  for (let cols = 4; cols >= 2; cols--) {
    const lastRow = count % cols === 0 ? cols : count % cols;
    if (lastRow >= 2) return cols;
  }
  return 4;
}

/** Tracking window as humane units (SUB-327): "42 min", "5 h 20 min",
    "4 d 11 h" — two largest units, zero remainders dropped. */
export function fmtWindow(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm > 0 ? `${h} h ${rm} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d} d ${rh} h` : `${d} d`;
}
