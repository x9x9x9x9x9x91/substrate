/* The Today surface's clock. The Scheduled lane knows what today holds but
   not where in today you are standing, so a 09:00 stand-up looks the same at
   08:00 as it does at 11:00. This module answers the two questions a glance
   asks — what is running, what is next and how long until it — as one pure
   pass over the lane's own entries, so the pane stays a dumb renderer. */

import { DEFAULT_DURATION_MIN, DAY_MIN, timeToMinutes } from "./weekgrid.ts";

/** The shape the cursor reads off a lane row — a CalEntry, narrowed. */
export interface ClockEntry {
  path: string;
  prop: string;
  day: string;
  time?: string;
  endDay?: string;
  endTime?: string;
}

export interface NowNext {
  /** key of the entry happening right now, if one is */
  now: string | null;
  /** key of the earliest entry still to start today */
  next: string | null;
  /** whole minutes until `next` starts; null when there is no next */
  untilMin: number | null;
}

const NONE: NowNext = { now: null, next: null, untilMin: null };

/** The key a row is identified by — the same `path:prop` pair the lane uses
    for its React keys, so the pane matches rows without a second lookup. */
export function clockKey(e: Pick<ClockEntry, "path" | "prop">): string {
  return `${e.path}:${e.prop}`;
}

/** How long a timed entry occupies. An explicit end on the same day sets it;
    an end on a later day runs the entry out to midnight; anything else gets
    the hour the calendar canvas already paints for an end-less entry, capped
    by the next entry's start so a forgotten 10:00 thing stops being "now"
    the moment the 10:30 one begins. */
function endOf(e: ClockEntry, start: number, nextStart: number | null): number {
  if (e.endDay && e.endDay > e.day) return DAY_MIN;
  const explicit = e.endTime ? timeToMinutes(e.endTime) : null;
  if (explicit !== null && explicit > start) return explicit;
  const capped = Math.min(start + DEFAULT_DURATION_MIN, nextStart ?? Infinity);
  return Math.max(capped, start + 1);
}

/** What's now and what's next among today's timed entries, given the local
    minute of day. All-day entries never answer either question — they are
    true all day, which makes them useless as a cursor. `nowMin` of null (the
    clock not read yet) yields no cursor rather than a guessed one. */
export function nowNextCursor(entries: ClockEntry[], nowMin: number | null): NowNext {
  if (nowMin === null) return NONE;
  const timed = entries
    .map((e) => ({ e, start: e.time ? timeToMinutes(e.time) : null }))
    .filter((t): t is { e: ClockEntry; start: number } => t.start !== null)
    .sort((a, b) => a.start - b.start);
  if (timed.length === 0) return NONE;

  let now: string | null = null;
  let next: string | null = null;
  let untilMin: number | null = null;
  for (let i = 0; i < timed.length; i++) {
    const { e, start } = timed[i];
    if (start > nowMin) {
      // the list is sorted, so the first future start is THE next one
      next = clockKey(e);
      untilMin = start - nowMin;
      break;
    }
    // a later-starting running entry wins: standing inside two overlapping
    // things, the one just begun is the one you are in
    const nextStart = timed.find((t) => t.start > start)?.start ?? null;
    if (nowMin < endOf(e, start, nextStart)) now = clockKey(e);
  }
  return { now, next, untilMin };
}

/** "in 25m", "in 2h", "in 2h 10m" — the countdown a row wears. Minutes below
    one read as "now" rather than "in 0m". */
export function untilLabel(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}
