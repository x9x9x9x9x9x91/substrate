import { numberLocale } from "./numberLocale.ts";

export function fmtAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface FxRate {
  usdEur: number;
  asOf: string;
  live: boolean;
}

/* The live FX read moved to the engine: the shipped CSP allows no
   remote origin, so the browser fetch that used to live here was blocked in
   the packaged app. It is now `fxUsdEur` in lib/ipc.ts, called from useFx. */

/** Money on dashboards: the app's de-DE dialect —
    German grouping ("1.234,56") with the symbol trailing after a space,
    same as euro cells render. */
export function fmtMoney(n: number | null, currency: "€" | "$", digits = 0): string {
  if (n === null || !isFinite(n)) return "—";
  return (
    n.toLocaleString(numberLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }) +
    " " +
    currency
  );
}

/** FX rate wherever it's quoted: de-DE like fmtMoney, always
    4 decimals ("0,8642") — a quote, not money, so no symbol attached. */
export function fmtFx(rate: number): string {
  return rate.toLocaleString(numberLocale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 });
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

/** Column count for a metrics board's card strip. One row of N
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

/** Tracking window as humane units: "42 min", "5 h 20 min",
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
