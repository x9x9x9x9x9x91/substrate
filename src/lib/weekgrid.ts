/** Layout math for the week view's timed canvas — pure minute
    arithmetic, no DOM. The component maps minutes to pixels; everything
    here is unit-testable: time parsing, drop snapping, and the lane layout
    that keeps concurrent entries side by side instead of stacked. */

export const DAY_MIN = 1440;
/** a timed entry with no end renders as a one-hour block (a
    same-day range carries one, and then the end time sets the height) */
export const DEFAULT_DURATION_MIN = 60;
/** shortest block the canvas paints — a 10-minute event still has to be
    clickable and wear its time */
export const MIN_BLOCK_MIN = 30;

const HH_MM = /^(\d{2}):(\d{2})$/;

/** "14:30" → 870; null for anything that isn't a valid HH:MM (24h). */
export function timeToMinutes(time: string): number | null {
  const m = HH_MM.exec(time);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** 870 → "14:30", clamped into the day (the last writable minute is 23:59). */
export function minutesToTime(min: number): string {
  const c = Math.min(Math.max(Math.round(min), 0), DAY_MIN - 1);
  const hh = String(Math.floor(c / 60)).padStart(2, "0");
  const mm = String(c % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Canvas drops land on a quarter-hour boundary — the grid promises a tidy
    value, not pixel-perfect mouse accuracy. Clamped so a drop past the last
    line stays inside the day. */
export function snapMinutes(min: number, step = 15): number {
  const snapped = Math.round(min / step) * step;
  return Math.min(Math.max(snapped, 0), DAY_MIN - step);
}

/** The minute interval a timed entry paints on the canvas. A
    same-day range (`date: … 09:00/… 17:00`) is one entry carrying both ends,
    so its block is as tall as the event really is; an entry with no end (or
    an end that doesn't parse, or one at/before its start — a bad value must
    not paint a zero-height sliver) falls back to the default hour. The end
    is floored to a minimum so a ten-minute event stays clickable, then
    clamped into the day. The same interval feeds `layoutLanes`: what
    overlaps visually is what has to share lanes. */
export function blockSpan(time: string, endTime?: string): { start: number; end: number } {
  const start = timeToMinutes(time) ?? 0;
  const parsedEnd = endTime ? timeToMinutes(endTime) : null;
  const raw = parsedEnd !== null && parsedEnd > start ? parsedEnd : start + DEFAULT_DURATION_MIN;
  return { start, end: Math.min(Math.max(raw, start + MIN_BLOCK_MIN), DAY_MIN) };
}

/** One timed entry's slot in its day column. `lane`/`lanes` translate to
    `left: lane/lanes`, `width: 1/lanes` — full width when nothing overlaps. */
export interface LaneBox {
  start: number;
  end: number;
  lane: number;
  lanes: number;
}

/** Assign overlapping intervals to side-by-side lanes, per cluster: a run of
    transitively-overlapping entries shares one lane count; disjoint runs
    reset to full width. Greedy lowest-free-lane on (start, end) order —
    output order mirrors input order. */
export function layoutLanes(items: { start: number; end: number }[]): LaneBox[] {
  const out: LaneBox[] = items.map((it) => ({ start: it.start, end: it.end, lane: 0, lanes: 1 }));
  const order = items
    .map((_, i) => i)
    .sort((a, b) => items[a].start - items[b].start || items[a].end - items[b].end);
  let cluster: number[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const i of cluster) out[i].lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };
  for (const i of order) {
    const it = items[i];
    if (cluster.length > 0 && it.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else {
      laneEnds[lane] = it.end;
    }
    out[i].lane = lane;
    cluster.push(i);
    if (it.end > clusterEnd) clusterEnd = it.end;
  }
  close();
  return out;
}
