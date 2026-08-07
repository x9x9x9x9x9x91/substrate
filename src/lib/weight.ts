// Weight log data for the food pane's strip overlay: one pure pass
// over the weight sheet's csv fence, shaping the polyline the 14-day strip
// draws over its kcal bars. The pane stays a dumb renderer; this module is the
// unit-tested half (the food.ts split).
//
// Weight is a CONTINUOUS quantity, unlike kcal: an unlogged day means "didn't
// step on the scale", not "weighed nothing" — so the line bridges gaps and
// only logged days get a dot.
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { readNoteTable } from "./notetable.ts";
import { normalizeNumberInput, parseStrictNumber } from "./aggregate.ts";

export interface WeightRow {
  /** local day, YYYY-MM-DD */
  date: string;
  kg: number;
}

export interface WeightPoint {
  /** local day, YYYY-MM-DD */
  day: string;
  kg: number;
  /** index into the day window the series was built for */
  col: number;
  /** 0 = bottom of the plot, 1 = top — the padded scale's position */
  y: number;
}

export interface WeightSeries {
  /** logged days inside the window, ascending */
  points: WeightPoint[];
  /** lowest / highest logged kg in the window (unpadded — the real numbers) */
  min: number;
  max: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sanity bounds on a weigh-in, the KCAL_MAX idea in kg: a digit-slip (724
    for 72.4) would otherwise pin the overlay's scale and flatten every real
    move for two weeks. */
export const KG_MIN = 20;
export const KG_MAX = 400;

export function kgInRange(n: number): boolean {
  return isFinite(n) && n >= KG_MIN && n <= KG_MAX;
}

/** The scale never spans less than this, so a single weigh-in (or two
    identical ones) sits mid-plot instead of dividing by zero. */
export const MIN_SPAN_KG = 1;

/** Share of the span left empty above and below the line, so the extremes
    don't ride the plot's edges. */
const PAD_FRAC = 0.2;

/** All well-formed rows of the weight sheet's csv fence, log order. Rows with
    a malformed date or a non-numeric / out-of-range kg are skipped, not
    errors — the sheet stays hand-editable, same tolerance as the food log. */
export function parseWeightRows(body: string): WeightRow[] {
  const table = readNoteTable(body);
  if (!table) return [];
  const di = table.col("date");
  const ki = table.col("kg");
  if (di < 0 || ki < 0) return [];
  const out: WeightRow[] = [];
  for (const cells of table.rows) {
    const date = table.text(cells, di);
    // strict parse like the food log: "7e1" is skipped text, never
    // a 70 kg weigh-in
    // Hand edits type the app's own de-DE display dialect ("72,5"), which the
    // strict parser alone reads as text — fold it first.
    const kg = parseStrictNumber(normalizeNumberInput(table.raw(cells, ki)));
    if (!DAY_RE.test(date) || kg === null || !kgInRange(kg)) continue;
    out.push({ date, kg });
  }
  return out;
}

/** The overlay for a day window (the strip's `days`, ascending): one point per
    logged day with its position on weight's OWN vertical scale — min/max over
    the window plus padding, so a 0.6 kg move reads as a move and not a flat
    line at the top of a 0–75 kg axis. Null when no day in the window has a
    weigh-in — the pane then draws nothing at all.

    A day logged twice keeps the LAST row: a corrected weigh-in is an edit,
    not a second day. */
export function weightSeries(body: string, days: string[]): WeightSeries | null {
  const byDay = new Map<string, number>();
  for (const r of parseWeightRows(body)) byDay.set(r.date, r.kg);

  const hits: { day: string; kg: number; col: number }[] = [];
  for (let i = 0; i < days.length; i++) {
    const kg = byDay.get(days[i]);
    if (kg !== undefined) hits.push({ day: days[i], kg, col: i });
  }
  if (hits.length === 0) return null;

  const min = Math.min(...hits.map((h) => h.kg));
  const max = Math.max(...hits.map((h) => h.kg));
  // widen a too-narrow (or zero) span symmetrically before padding, so one
  // point lands dead centre instead of at an undefined 0/0
  const span = Math.max(max - min, MIN_SPAN_KG);
  const mid = (min + max) / 2;
  const lo = mid - span / 2 - span * PAD_FRAC;
  const hi = mid + span / 2 + span * PAD_FRAC;

  return {
    points: hits.map((h) => ({ ...h, y: (h.kg - lo) / (hi - lo) })),
    min,
    max,
  };
}
