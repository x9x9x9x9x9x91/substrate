import { daysBetween, daysInMonth, shiftDate } from "./dates.ts";
import { byFoldedKey, propSchemaFor, typeSchemaFor } from "./schemalookup.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { foldedPropKey, foldedPropStr, FUNCTIONAL_TYPES, propStr } from "./types.ts";
import { DAY_MIN, minutesToTime, timeToMinutes } from "./weekgrid.ts";

/** One note placed on one day of the calendar. `prop` names the frontmatter
    key that carries the date — it is what a drag to another day rewrites. */
export interface CalEntry {
  path: string;
  title: string;
  /** the note's database type; "" for untyped notes */
  type: string;
  prop: string;
  /** local day, YYYY-MM-DD — day-only even when the prop value carries a time */
  day: string;
  /** the value's optional time-of-day, HH:MM 24h; absent = all-day */
  time?: string;
  /** last day of a multi-day range, YYYY-MM-DD — absent on ordinary
      single dates. Present on EVERY day the span covers, so any surface can
      tell a span apart from a one-day entry without re-reading the note. */
  endDay?: string;
  /** the range end's optional time-of-day, HH:MM 24h */
  endTime?: string;
  /** where this day sits in its span: the span's first day, its
      last, or a day in between. Absent on single dates. A one-day range
      (start === end) is "start" — there is nothing to continue. */
  spanPos?: "start" | "mid" | "end";
  /** the note's `status` prop verbatim, when it carries one */
  status?: string;
  /** true on every instance of a `repeat:` series, anchor included */
  repeating?: boolean;
}

/* Props that never count as calendar dates, however date-shaped their value:
   `created` is on every note, `calendar` is the opt-out flag, the
   `repeat*` keys drive recurrence (`repeat_until` is date-shaped!),
   the rest carry identity, not scheduling. */
const NOT_DATE = new Set([
  "created",
  "updated",
  "title",
  "type",
  "calendar",
  "repeat",
  "repeat_until",
  "repeat_skip",
]);

/* FUNCTIONAL_TYPES (types.ts): app-machinery types' date-shaped props are
   metadata, not scheduling. The schema may still declare a date prop on any
   type — explicit beats heuristic. */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local YYYY-MM-DD — calendar days are day-precision and timezone-local. */
export function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Strict YYYY-MM-DD → local Date, rejecting impossible dates (2026-02-30).

    The year is written back explicitly: the multi-arg Date
    constructor applies JS's legacy two-digit-year rule to years 0–99, so
    `new Date(99, 0, 1)` is 1999, not year 99. The round-trip check only
    covered month and day, so "0099-01-01" came back as a Date in 1999 — off
    by nineteen centuries and silently accepted. setFullYear undoes the
    offset without disturbing the rollover the month/day check relies on, and
    the year is now round-tripped too. */
export function parseDay(s: string): Date | null {
  const m = ISO_DAY.exec(s);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, day);
  d.setFullYear(y);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day ? d : null;
}

/* A date prop value with an optional time-of-day: the ISO day,
   optionally followed by a space or T and HH:MM (24h). Day-only values stay
   the common case; the time never leaks into day keys anywhere. A
   single-digit hour is accepted and normalized to the padded form,
   so a hand-written `9:30` reads the same as the DateMenu's typed input. */
const DAY_TIME_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/;

/** One endpoint of a date value: the ISO day plus its optional time. */
export interface DayTime {
  day: string;
  time: string | null;
}

/** A parsed date value: always a start, optionally an end. */
export interface DateRange {
  start: DayTime;
  /** the range's closing endpoint; null for an ordinary single date */
  end: DayTime | null;
}

function splitEndpoint(value: string): DayTime | null {
  const m = DAY_TIME_RE.exec(value.trim());
  if (!m || !parseDay(m[1])) return null;
  if (m[2] === undefined) return { day: m[1], time: null };
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return null;
  return { day: m[1], time: `${String(hh).padStart(2, "0")}:${m[3]}` };
}

/** Chronological order of two endpoints — no time sorts before any time on
    the same day, which is also how an all-day value reads. */
function cmpDayTime(a: DayTime, b: DayTime): number {
  return a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? "");
}

function fmtDayTime(p: DayTime): string {
  return p.time ? `${p.day} ${p.time}` : p.day;
}

/** Build a date prop value — the `day[ HH:MM]` form, with
    the `/end` half appended when there is an end. Every write path
    funnels through here so none of them can emit a range splitDateRange then
    rejects, which would drop the note off every calendar surface.

    Two orderings are enforced, both only reachable on a SAME-DAY range:
    an end with no time sorts BEFORE any start time (cmpDayTime), so a timed
    start with a day-only end inherits the start's time rather than reversing;
    and two times out of order swap, the same idiom the picker already uses on
    the two picked days. Cross-day pairs swap too, for the same reason. */
export function dateRangeValue(
  day: string,
  time?: string | null,
  end?: { day: string; time?: string | null } | null
): string {
  const start: DayTime = { day, time: time || null };
  if (!end) return fmtDayTime(start);
  const finish: DayTime = {
    day: end.day,
    // day-only end + timed start on the same day would read as reversed
    time: end.time || (end.day === start.day ? start.time : null),
  };
  const [a, b] = cmpDayTime(finish, start) < 0 ? [finish, start] : [start, finish];
  return `${fmtDayTime(a)}/${fmtDayTime(b)}`;
}

/** free-typed HH:MM — one or two hour digits, exactly two minute digits */
const TIME_ENTRY_RE = /^(\d{1,2}):([0-5]\d)$/;
/** what someone types when they mean "no time at all" */
const ALL_DAY_RE = /^all[ _-]?day$/i;

/** What a typed time field means. An empty field and the words "all day"
    (however spaced or cased) are the same request: drop the time. Anything
    else that isn't HH:MM is a typo, and the caller puts the old value back
    rather than guessing. */
export type TimeEntry =
  | { kind: "clear" }
  | { kind: "time"; time: string }
  | { kind: "invalid" };

export function parseTimeEntry(raw: string): TimeEntry {
  const s = raw.trim();
  if (!s || ALL_DAY_RE.test(s)) return { kind: "clear" };
  const m = TIME_ENTRY_RE.exec(s);
  if (!m || Number(m[1]) > 23) return { kind: "invalid" };
  return { kind: "time", time: `${m[1].padStart(2, "0")}:${m[2]}` };
}

/** The value a time edit writes: the stored range with a new start time.

    `time` null is a revert to all-day, and it clears the END's time too — an
    event drawn on the timed canvas is written as start AND end, so keeping
    the end timed would leave it timed forever, which is the bug this rule
    exists for. A span that crosses days keeps its end DAY (a three-day event
    becomes a three-day all-day band); an end sitting on the start's own day
    only existed to give the block a length, so it goes with the time.

    A typed time that lands at or after the stored end is the one case where
    the end cannot stay put: only a same-day timed end can be overtaken (a
    later day never is, and a stored value can't already be reversed), and
    leaving it would let `dateRangeValue` SWAP the pair — writing a start the
    user never typed and snapping the field back. The typed time IS the
    start, so the END moves instead: the block keeps its LENGTH
    (`shiftedRangeEnd`, the same duration arithmetic a drop uses), and only
    when that can't produce a later end — an untimed stored start, or a
    zero-length block — does it fall back to the resize floor
    (`clampedRangeEnd`).

    Every other edit leaves the end exactly as stored. `fallbackDay` is used
    when the note has no parseable value yet. */
export function retimedRangeValue(
  stored: DateRange | null,
  fallbackDay: string,
  time: string | null,
): string {
  const day = stored?.start.day ?? fallbackDay;
  const end = !stored?.end
    ? null
    : time === null
      ? stored.end.day === stored.start.day
        ? null
        : { day: stored.end.day }
      : heldOrMovedEnd(stored.start, stored.end, time);
  return dateRangeValue(day, time, end);
}

/** The end a time edit leaves behind — the stored one, unless the new start
    has overtaken it (see `retimedRangeValue`). Split out so the swap guard
    reads as one thought instead of a fourth nested ternary. */
function heldOrMovedEnd(
  start: DayTime,
  end: DayTime,
  time: string,
): { day: string; time?: string } {
  const held = { day: end.day, time: end.time ?? undefined };
  const overtaken = end.day === start.day && !!end.time && time >= end.time;
  if (!overtaken) return held;
  const moved = shiftedRangeEnd(
    { day: start.day, time: start.time, endDay: end.day, endTime: end.time },
    { day: start.day, time },
  );
  if (moved && (moved.day > start.day || (moved.time ?? "") > time)) return moved;
  return clampedRangeEnd({ day: start.day, time }, held);
}

/** The end a spanning entry keeps when its start moves to `to`.
    The span holds its LENGTH: when both the stored endpoints and the new
    start carry times, the duration is preserved to the minute — an 8-hour
    block dropped on the timed canvas stays 8 hours, rolling past midnight
    into the next day when it must. Day-only spans (and drops that leave the
    start untimed) keep the older whole-days behavior: the end travels the
    same number of days and its own time rides along verbatim. Returns null
    for a non-span or an unparseable endpoint. */
export function shiftedRangeEnd(
  span: { day: string; time?: string | null; endDay?: string; endTime?: string | null },
  to: { day: string; time?: string | null }
): { day: string; time?: string } | null {
  if (!span.endDay) return null;
  const from = parseDay(span.day);
  const target = parseDay(to.day);
  const end = parseDay(span.endDay);
  if (!from || !target || !end) return null;
  const startMin = span.time ? timeToMinutes(span.time) : null;
  const endMin = span.endTime ? timeToMinutes(span.endTime) : null;
  const newStartMin = to.time ? timeToMinutes(to.time) : null;
  if (startMin !== null && endMin !== null && newStartMin !== null) {
    const spanDays = Math.round((end.getTime() - from.getTime()) / 86400000);
    const duration = spanDays * DAY_MIN + endMin - startMin;
    // a stored value can't end before it starts (splitDateRange rejects it),
    // but the drag state isn't proof — fall through rather than invert
    if (duration >= 0) {
      const total = newStartMin + duration;
      const dayDelta = Math.floor(total / DAY_MIN);
      return {
        day: isoDay(addDays(target, dayDelta)),
        time: minutesToTime(total - dayDelta * DAY_MIN),
      };
    }
  }
  const deltaDays = Math.round((target.getTime() - from.getTime()) / 86400000);
  return { day: isoDay(addDays(end, deltaDays)), time: span.endTime ?? undefined };
}

/** Where a range's START lands when a drop releases it on `day`.

    Grabbing the range's own start puts that start under the pointer, which is
    every single-day move. Grabbing a LATER day of a span (`grabDay`) is a
    request to slide the whole range instead: the start travels the same
    number of days the pointer did, so a three-day event taken hold of by its
    middle day keeps its shape rather than jumping a day back under the
    cursor. Whole-day arithmetic throughout — `daysBetween` counts calendar
    days from the y/m/d components, so a clock change inside the travel can't
    drift the count, and the result may sit in an earlier month or year than
    the grid that was dropped on. An endpoint that isn't a real ISO day falls
    back to the dropped day, the same placement an ordinary grab gets. */
export function droppedRangeStart(
  span: { day: string; grabDay?: string },
  day: string
): string {
  if (!span.grabDay || span.grabDay === span.day) return day;
  if (!parseDay(span.day) || !parseDay(span.grabDay) || !parseDay(day)) return day;
  return shiftDate(span.day, daysBetween(span.grabDay, day));
}

/** Shortest event a resize can leave behind — one snap step of the
    canvas grid, so a drag or a typed end that lands at or before the start
    settles on the next grid line. */
const MIN_RANGE_MIN = 15;

/** The end a resize commits, never before its start. Dragging an
    event's bottom edge up past its own top — or typing an earlier end in the
    peek — must not turn the event inside out: dateRangeValue SWAPS a reversed
    pair, which would silently move the start instead, so every resize path
    clamps here first. A reversed timed pair lands `minMinutes` after the
    start, rolling into the next day when the start sits near midnight; when
    either endpoint is day-only there is nothing finer than whole days to
    compare, so an earlier end collapses onto the start's day — except a
    day-only end against a TIMED start, which settles on the following day
    instead (the degeneracy guard below). */
export function clampedRangeEnd(
  start: { day: string; time?: string | null },
  end: { day: string; time?: string | null },
  minMinutes = MIN_RANGE_MIN
): { day: string; time?: string } {
  const from = parseDay(start.day);
  const target = parseDay(end.day);
  const endTime = end.time ?? undefined;
  if (!from || !target) return { day: start.day, time: endTime };
  const dayDelta = Math.round((target.getTime() - from.getTime()) / 86400000);
  const startMin = start.time ? timeToMinutes(start.time) : null;
  const endMin = end.time ? timeToMinutes(end.time) : null;
  if (startMin === null || endMin === null) {
    // a day-only end may not land on (or before) a timed start's day — see
    // the guard's doc. Reachable since the peek's end-day picker: pick the
    // start's own day while the stored end carries no hour.
    if (timedStartMeetsDayOnlyEnd(startMin, endMin, dayDelta))
      return { day: isoDay(addDays(from, 1)), time: endTime };
    return { day: dayDelta < 0 ? start.day : end.day, time: endTime };
  }
  const floor = startMin + minMinutes;
  if (dayDelta * DAY_MIN + endMin >= floor) return { day: end.day, time: endTime };
  const roll = Math.floor(floor / DAY_MIN);
  return { day: isoDay(addDays(from, roll)), time: minutesToTime(floor - roll * DAY_MIN) };
}

/** Shared degeneracy guard for the day-only clamp branches. A TIMED start
    against a DAY-ONLY end may never share the end's day: `dateRangeValue`
    copies the start's clock onto a same-day day-only end (the reversed-pair
    rule above), which would write a zero-minute range. At day granularity
    the honest clamp is a full day of clearance — the analogue of the timed
    pair's `minMinutes`.

    Deliberately NOT covering two day-only endpoints: those collapse onto one
    day, which composes to a same-day `D/D` value with an end no surface can
    show. Today's callers never feed that in (the peek's end-day handler
    drops the end whole first, and the top grip always carries a time) — a
    NEW caller of either clamp must keep that promise or widen this guard. */
const timedStartMeetsDayOnlyEnd = (
  startMin: number | null,
  endMin: number | null,
  dayDelta: number,
) => startMin !== null && endMin === null && dayDelta <= 0;

/** The start a resize commits, never at or past its end — the top-edge
    grip's twin of `clampedRangeEnd`. Dragging an event's top edge down
    through its own bottom must not turn the event inside out either: a
    reversed timed pair settles `minMinutes` before the end, rolling back
    into the previous day when the end sits just past midnight; when either
    endpoint is day-only a start later than the end collapses onto the
    end's day — except a TIMED start against a day-only end, which settles
    on the day before it instead (the degeneracy guard above). */
export function clampedRangeStart(
  start: { day: string; time?: string | null },
  end: { day: string; time?: string | null },
  minMinutes = MIN_RANGE_MIN
): { day: string; time?: string } {
  const from = parseDay(start.day);
  const target = parseDay(end.day);
  const startTime = start.time ?? undefined;
  if (!from || !target) return { day: end.day, time: startTime };
  const dayDelta = Math.round((target.getTime() - from.getTime()) / 86400000);
  const startMin = start.time ? timeToMinutes(start.time) : null;
  const endMin = end.time ? timeToMinutes(end.time) : null;
  if (startMin === null || endMin === null) {
    // a timed start may not land on (or past) a day-only end's day — see
    // the guard's doc. The top grip is the first caller that can aim an
    // arbitrary day at this branch.
    if (timedStartMeetsDayOnlyEnd(startMin, endMin, dayDelta))
      return { day: isoDay(addDays(target, -1)), time: startTime };
    return { day: dayDelta < 0 ? end.day : start.day, time: startTime };
  }
  if (dayDelta * DAY_MIN + endMin - startMin >= minMinutes)
    return { day: start.day, time: startTime };
  const ceil = endMin - minMinutes;
  const roll = Math.floor(ceil / DAY_MIN);
  return { day: isoDay(addDays(target, roll)), time: minutesToTime(ceil - roll * DAY_MIN) };
}

/** Parse a date prop value, range-aware. The grammar is the date value,
    optionally followed by `/` and a second one (the ISO-8601
    interval form): `2026-09-01/2026-09-21`, `2026-09-01 09:00/2026-09-03 17:00`.
    Both endpoints must parse and the end may not precede the start — a
    half-written or reversed range is not a date value at all, so it falls
    through to plain-text handling exactly like `soonish` does. Values without
    a `/` return `end: null` and behave as they always have.

    The `/` split happens BEFORE the separator scan on purpose: the endpoints
    may each carry a space-separated time, so scanning for the separator first
    would cut a timed range in the wrong place. Mirrored in Rust by
    `notify::parse_due_range` — the two grammars must stay in lockstep. */
export function splitDateRange(value: string): DateRange | null {
  const raw = value.trim();
  const cut = raw.indexOf("/");
  if (cut === -1) {
    const only = splitEndpoint(raw);
    return only ? { start: only, end: null } : null;
  }
  const start = splitEndpoint(raw.slice(0, cut));
  const end = splitEndpoint(raw.slice(cut + 1));
  if (!start || !end || cmpDayTime(end, start) < 0) return null;
  return { start, end };
}

/** Split an optional-time date value into the endpoint everything keys on:
    the START. Returns null if not a valid date value. Validates the day via
    parseDay and the time range (00-23:00-59). parseDay stays strict day-only —
    gates that should tolerate a time route here.

    A range value splits to its start, so every surface that sorts,
    filters, buckets, or anchors by "the date" keeps doing so on the day the
    item begins. Surfaces that care about the span read `splitDateRange`. */
export function splitDayTime(value: string): DayTime | null {
  return splitDateRange(value)?.start ?? null;
}

/** The last day an entry occupies: its range end when it has one,
    else the day itself. The one "has this passed?" reading — a span is not
    late while it is still running. */
export function entryEndDay(e: CalEntry): string {
  return e.endDay ?? e.day;
}

/** Intra-day order: all-day (day-only) entries first, then timed
    entries ascending by time. Compose AHEAD of the existing type/title
    tiebreaks — "" sorts before any "HH:MM". */
export function compareEntryTime(a: CalEntry, b: CalEntry): number {
  return (a.time ?? "").localeCompare(b.time ?? "");
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth() + n, 1);
  // keep the day of month where it exists (Jan 31 + 1mo → Feb 28)
  out.setDate(Math.min(d.getDate(), daysInMonth(out.getFullYear(), out.getMonth() + 1)));
  return out;
}

/** Weeks start Monday. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(out, -((out.getDay() + 6) % 7));
}

/** The cells of a month grid: full Monday-start weeks covering the month —
    only the 4–6 weeks that intersect it, never a dead trailing row. */
export function monthGridDays(year: number, month0: number): Date[] {
  const first = startOfWeek(new Date(year, month0, 1));
  const firstWeekday = (new Date(year, month0, 1).getDay() + 6) % 7; // Monday = 0
  const weeks = Math.ceil((firstWeekday + daysInMonth(year, month0 + 1)) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
}

export function weekDays(d: Date): Date[] {
  const first = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** The Day layout's column set: Day IS the week canvas at one
    column, so it hands back the same shape the canvas already consumes — a
    Date[] — carrying the cursor's day, normalized to midnight like
    weekDays/monthGridDays do. */
export function dayColumn(d: Date): Date[] {
  return [new Date(d.getFullYear(), d.getMonth(), d.getDate())];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function monthTitle(year: number, month0: number): string {
  return `${MONTHS[month0]} ${year}`;
}

/** "Jul 17" this year, "Jul 17, 2026" otherwise. */
export function humanDay(iso: string, now = new Date()): string {
  const d = parseDay(iso);
  if (!d) return iso;
  const base = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** The number a month cell shows for its date: the 1st names its month
    ("Aug 1"), every other day stays a bare number — the grid always shows
    days from two or three months, and the seam is otherwise invisible. */
export function cellDayLabel(d: Date): string {
  return d.getDate() === 1 ? `${MONTHS_SHORT[d.getMonth()]} 1` : String(d.getDate());
}

/** A prop counts as a calendar date when the schema declares `kind: "date"`,
    or — with no schema ruling — when the value is shaped like an ISO day with
    an optional time. Explicit other kinds (file, …) and reserved
    props never count. */
function isDateValue(schemaKind: string | undefined, key: string, value: unknown): boolean {
  if (NOT_DATE.has(key.toLowerCase()) || schemaKind === "file") return false;
  if (typeof value !== "string") return false;
  if (schemaKind === "date") return splitDayTime(value) !== null;
  if (schemaKind !== undefined) return false;
  return splitDayTime(value) !== null;
}

/** A note is complete when its `status` prop reads done or cancelled —
   case-insensitive, trimmed. The one status-aware predicate; every
   surface reuses it, never compare status strings inline. */
export function isComplete(status: string | undefined): boolean {
  const s = status?.trim().toLowerCase();
  return s === "done" || s === "cancelled";
}

/** A date prop is a deadline when the schema flags it for due-date
    notifications — the same opt-in the scheduler fires on. Lives here
    (not agenda.ts) so the calendar's overdue helper shares it without a
    module cycle; agenda.ts re-exports it.

    A lead time alone counts: the scheduler fires for
    `notifyBefore > 0` with `notify` off, so Today/Calendar must show that
    prop too — otherwise the alert points at an entry no surface lists. */
export function isDeadline(schema: SchemaConfig, type: string, prop: string): boolean {
  const ps = propSchemaFor(schema, type, prop);
  if (ps?.kind !== "date") return false;
  return ps.notify === true || (ps.notifyBefore ?? 0) > 0;
}

/** Status schema for Calendar entry actions, folding both the entry's stored
    Type spelling and the schema's status-property spelling. */
export function statusSchemaFor(schema: SchemaConfig, type: string) {
  return propSchemaFor(schema, type, "status");
}

/* A single range never expands past this many days, however far apart its
   endpoints are — a typo'd century keeps the calendar responsive. The clipped
   tail simply isn't drawn; the value on disk is untouched. */
const MAX_SPAN_DAYS = 366;

/** The days a range entry occupies. The start day is ALWAYS emitted,
    window or not — non-repeating entries have always been window-agnostic, and
    overdue/agenda scans rely on seeing an item whose start has passed. The
    remaining days are clipped to `window` when one is given, so paging the grid
    never expands a span the user can't see. */
function spanDays(start: string, end: string, window?: CalWindow): string[] {
  const days = [start];
  const from = parseDay(start);
  if (!from) return days;
  const seen = new Set(days);
  // A window jumps straight to its own slice of the span: the cap
  // bounds ITERATIONS, so counting them from the range's start made a window
  // more than MAX_SPAN_DAYS past that start emit nothing — a legitimate
  // multi-year range vanished from the grid, Today and Upcoming mid-span.
  const winStart = window ? parseDay(window.start) : null;
  const first = winStart ? Math.max(1, dayDiff(from, winStart)) : 1;
  for (let i = first; i < first + MAX_SPAN_DAYS; i++) {
    const day = isoDay(addDays(from, i));
    if (day > end) break;
    if (window && (day < window.start || day > window.end)) continue;
    if (seen.has(day)) continue;
    seen.add(day);
    days.push(day);
  }
  return days;
}

/** Every calendar entry a note contributes. A range-valued date prop
    yields one entry per day it covers — same note, same prop, one row per day —
    each carrying `endDay`/`spanPos` so renderers can draw a continuous span
    instead of unrelated chips. `window` clips the span's interior days only. */
export function entriesForNote(
  n: NoteMeta,
  schema: SchemaConfig,
  window?: CalWindow
): CalEntry[] {
  // per-note opt-out: YAML parses `calendar: false` to a bool, but
  // imports and hand edits may carry the string — both hide the note
  const optOut = n.props[foldedPropKey(n.props, "calendar")];
  if (optOut === false || optOut === "false") return [];
  const type = foldedPropStr(n.props, "type") ?? "";
  const status = foldedPropStr(n.props, "status");
  // the note's `type` and the schema's key are both hand-authored; a casing
  // mismatch must not silently drop the type's date rules
  const typeSchema = typeSchemaFor(schema, type) ?? {};
  const heuristic = !FUNCTIONAL_TYPES.has(type.toLowerCase());
  const out: CalEntry[] = [];
  for (const key of Object.keys(n.props)) {
    const kind = byFoldedKey(typeSchema, key)?.kind;
    if (kind === undefined && !heuristic) continue;
    if (!isDateValue(kind, key, n.props[key])) continue;
    const raw = propStr(n.props, key);
    if (!raw) continue;
    // the day keys the calendar; an optional time rides the entry
    const range = splitDateRange(raw);
    if (!range) continue;
    const { start, end } = range;
    const base: CalEntry = { path: n.path, title: n.title, type, prop: key, day: start.day };
    if (start.time) base.time = start.time;
    if (status !== undefined) base.status = status;
    // a single date is one entry, exactly as before
    if (!end || end.day === start.day) {
      if (end) {
        base.endDay = end.day;
        if (end.time) base.endTime = end.time;
        base.spanPos = "start";
      }
      out.push(base);
      continue;
    }
    for (const day of spanDays(start.day, end.day, window)) {
      const e: CalEntry = { ...base, day, endDay: end.day };
      if (end.time) e.endTime = end.time;
      e.spanPos = day === start.day ? "start" : day === end.day ? "end" : "mid";
      // only the span's first day carries the start time — a continuation day
      // is all-day, so it sits in the strip instead of stacking at 09:00
      if (day !== start.day) delete e.time;
      out.push(e);
    }
  }
  return out;
}

/** Recurrence cadence parsed from a note's `repeat:` prop. */
export interface Repeat {
  unit: "day" | "week" | "month" | "year";
  n: number;
}

const REPEAT_BARE: Record<string, Repeat["unit"]> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};
const REPEAT_EVERY = /^every (\d+) (days?|weeks?|months?|years?)$/;

/** The `repeat:` grammar, case-insensitive and trimmed: `daily` / `weekly` /
    `monthly` / `yearly`, or `every N days|weeks|months|years` (N ≥ 1 integer,
    singular forms accepted). Anything else → null: the note is simply
    non-repeating — no error, no entries. */
export function parseRepeat(v: unknown): Repeat | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  const bare = REPEAT_BARE[s];
  if (bare) return { unit: bare, n: 1 };
  const m = REPEAT_EVERY.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  // \d+ can still overflow to Infinity (309+ digits); repeatStep multiplies
  // by n, and 0 × Infinity = NaN would render the anchor as "NaN-NaN-NaN"
  // instead of the promised silent null
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { unit: m[2].replace(/s$/, "") as Repeat["unit"], n };
}

/** Inclusive ISO-day bounds for recurrence expansion. */
export interface CalWindow {
  start: string;
  end: string;
}

/* Runaway guard: one (note, prop) series never expands past this many
   in-window occurrences. */
const MAX_OCCURRENCES = 1000;

/** The k-th occurrence of a series anchored on `anchor` (k = 0 is the anchor).
    Monthly/yearly step from the anchor each time, so Jan 31 → Feb 28 → Mar 31. */
function repeatStep(anchor: Date, r: Repeat, k: number): string {
  const step = k * r.n;
  switch (r.unit) {
    case "day":
      return isoDay(addDays(anchor, step));
    case "week":
      return isoDay(addDays(anchor, 7 * step));
    case "month":
      return isoDay(addMonths(anchor, step));
    case "year":
      return isoDay(addMonths(anchor, 12 * step));
  }
}

/** Whole days between two local dates, DST-proof: compare the calendar
    components as UTC midnights, never elapsed milliseconds (a spring-forward
    day is 23h long and would floor a day short). */
function dayDiff(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** The smallest k ≥ 0 whose occurrence lands on or after `start` — computed
    arithmetically instead of walking every occurrence from the anchor (the
    walk made expansion cost grow with the anchor's distance from the
    viewport, so a far-back window spent its whole budget getting there).

    The estimate is exact for day/week cadences and off by at most one step for
    month/year, where clamping (Jan 31 → Feb 28) can pull an occurrence back
    across the boundary; the two small corrections below settle that and cost a
    bounded couple of iterations, never a walk. */
function seekToWindow(anchor: Date, r: Repeat, start: string): number {
  const startDate = parseDay(start);
  if (!startDate) return 0;
  let k: number;
  if (r.unit === "day" || r.unit === "week") {
    const per = r.unit === "week" ? 7 * r.n : r.n;
    k = Math.ceil(dayDiff(anchor, startDate) / per);
  } else {
    const per = r.unit === "year" ? 12 * r.n : r.n;
    const months =
      (startDate.getFullYear() - anchor.getFullYear()) * 12 +
      (startDate.getMonth() - anchor.getMonth());
    k = Math.floor(months / per);
  }
  if (k < 0) k = 0;
  // land exactly on the first in-window occurrence: back off while the
  // previous one still qualifies, advance while this one falls short
  while (k > 0 && repeatStep(anchor, r, k - 1) >= start) k--;
  while (repeatStep(anchor, r, k) < start) k++;
  return k;
}

/** Every dated note in the vault, one entry per (note, date prop) — with
    recurrence expanded: a note carrying `repeat:` yields its anchor
    plus virtual occurrences inside `window`, stopping at `repeat_until`
    (inclusive) and dropping days listed in `repeat_skip` (the anchor itself
    may be skipped — that is "delete this occurrence" on the first instance).
    One note on disk, many calendar instances; nothing is materialized.
    Without a window a series emits only its surviving anchor; non-repeating
    notes are window-agnostic. `repeat` applies to all of the note's date
    props identically. An anchor's time-of-day carries onto every
    occurrence; `repeat_until`/`repeat_skip` stay day-only comparisons.

    Recurrence ignores ranges: a repeating note's range-valued prop
    expands from its START day like any other date, and the occurrences are
    single days — the span is NOT carried onto them. A repeating multi-day
    span is a second scheduling concept (overlapping occurrences, spans that
    outrun their own cadence) and is deliberately out of scope; documented in
    docs/vault-format.md §6. */
export function calendarEntries(
  notes: NoteMeta[],
  schema: SchemaConfig,
  window?: CalWindow
): CalEntry[] {
  return notes.flatMap((n) => {
    const base = entriesForNote(n, schema, window);
    const repeat = parseRepeat(n.props[foldedPropKey(n.props, "repeat")]);
    if (!repeat) return base;
    const untilRaw = foldedPropStr(n.props, "repeat_until");
    const until = untilRaw && parseDay(untilRaw) ? untilRaw : null;
    const skipRaw = n.props[foldedPropKey(n.props, "repeat_skip")];
    const skip = new Set(
      (Array.isArray(skipRaw) ? skipRaw : [skipRaw]).filter(
        (v): v is string => typeof v === "string" && parseDay(v) !== null
      )
    );
    // recurrence ignores ranges: a series expands from the span's
    // START, one single-day occurrence per step — the continuation days and
    // the span metadata are dropped rather than multiplied by the cadence
    return base
      .filter((e) => e.spanPos === undefined || e.spanPos === "start")
      .flatMap((span) => {
        const e = { ...span };
        delete e.endDay;
        delete e.endTime;
        delete e.spanPos;
        const anchor = parseDay(e.day);
        if (!anchor) return [e];
        const out: CalEntry[] = [];
        let count = 0; // in-window occurrences considered, emitted or skipped
        // seek straight to the window instead of walking there
        const first = window ? seekToWindow(anchor, repeat, window.start) : 0;
        for (let k = first; ; k++) {
          const day = repeatStep(anchor, repeat, k);
          // the anchor is a real dated note, not a virtual occurrence — an
          // until BEFORE it (usually a typo) truncates the series, never hides
          // the note itself
          if (until && day > until && k > 0) break;
          if (window) {
            if (day > window.end) break;
            if (++count > MAX_OCCURRENCES) break;
          } else if (k > 0) break; // windowless: the anchor only
          if (skip.has(day)) continue;
          out.push({ ...e, day, repeating: true });
        }
        return out;
      });
  });
}

/** Entries across several disjoint windows, deduped by (note, prop, day).

    The calendar renders two spans that drift apart — the grid the
    user paged to, and the fixed 14-day Upcoming list rooted at today. Covering
    both with ONE window meant the span stretched without bound as you paged
    back, and past ~1000 days MAX_OCCURRENCES truncated a daily series before
    it ever reached today: the grid looked fine while Today and Upcoming went
    empty. Two bounded windows keep each surface's expansion budget its own.
    Non-repeating entries are window-agnostic, so they surface in every window
    and the dedupe collapses them back to one. */
export function calendarEntriesForWindows(
  notes: NoteMeta[],
  schema: SchemaConfig,
  windows: CalWindow[]
): CalEntry[] {
  const seen = new Set<string>();
  const out: CalEntry[] = [];
  for (const w of windows) {
    for (const e of calendarEntries(notes, schema, w)) {
      const key = JSON.stringify([e.path, e.prop, e.day]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** The calendar's overdue list: non-repeating deadline entries whose
    day passed before `today`, oldest first. The scan mirrors agendaPayload's:
    the [today, today] window bounds recurrence expansion only — non-repeating
    entries are window-agnostic, so every past deadline is seen at no extra
    expansion cost. A series is never overdue: it always has a next
    occurrence — and a complete entry never is either, matching the
    Today strip's count. A range is overdue only once its END day has
    passed: a span still running is not late. */
export function overdueEntries(
  notes: NoteMeta[],
  schema: SchemaConfig,
  today: string
): CalEntry[] {
  const out: CalEntry[] = [];
  for (const e of calendarEntries(notes, schema, { start: today, end: today })) {
    if (
      e.day < today &&
      entryEndDay(e) < today &&
      !e.repeating &&
      !isComplete(e.status) &&
      isDeadline(schema, e.type, e.prop)
    )
      out.push(e);
  }
  return out.sort(
    (a, b) =>
      a.day.localeCompare(b.day) || compareEntryTime(a, b) || a.title.localeCompare(b.title)
  );
}

/** Types that can be created from the calendar: standalone `event` first,
    then every schema database declaring a date-kind prop, alphabetically
    (deriving the picker from dated ENTRIES let any imported type
    with a date-shaped prop in as a nonsense create-as category). Functional
    types stay out even when they declare one; reserved type-map keys (icon,
    home) aren't prop specs, hence the `?.kind`. */
export function calendarTypes(schema: SchemaConfig): string[] {
  const dated = Object.keys(schema)
    .filter((t) => t.toLowerCase() !== "event" && !FUNCTIONAL_TYPES.has(t.toLowerCase()))
    .filter((t) => Object.values(schema[t]).some((s) => s?.kind === "date"))
    .sort((a, b) => a.localeCompare(b));
  return ["event", ...dated];
}

/** Which prop a new entry of `type` writes its day into: the schema-declared
    date prop, else the type's most-used date-shaped prop, else `date`. */
export function datePropFor(type: string, notes: NoteMeta[], schema: SchemaConfig): string {
  const foldedType = type.toLowerCase();
  const ofType = notes.filter(
    (n) => (foldedPropStr(n.props, "type") ?? "").toLowerCase() === foldedType
  );
  const declared = Object.entries(typeSchemaFor(schema, type) ?? {})
    .filter(([, s]) => s.kind === "date")
    .map(([k]) => k)
    .sort();
  if (declared.length > 0) {
    const foldedProp = declared[0].toLowerCase();
    for (const n of ofType) {
      const observed = foldedPropKey(n.props, declared[0]);
      if (observed.toLowerCase() === foldedProp && Object.prototype.hasOwnProperty.call(n.props, observed))
        return observed;
    }
    return declared[0];
  }
  const counts = new Map<string, { key: string; count: number }>();
  for (const n of ofType) {
    const seen = new Set<string>();
    for (const key of Object.keys(n.props)) {
      if (!isDateValue(undefined, key, n.props[key])) continue;
      const folded = key.toLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      const prior = counts.get(folded);
      if (prior) prior.count += 1;
      else counts.set(folded, { key, count: 1 });
    }
  }
  const best = [...counts.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])
  )[0];
  return best?.[1].key ?? "date";
}

/** Where a new entry of `type` files itself: standalone events live in
    Calendar/, a database with a home folder lands there explicitly,
    otherwise the type keeps living where most of it already lives. */
export function folderFor(type: string, notes: NoteMeta[], home?: string): string {
  const foldedType = type.toLowerCase();
  if (foldedType === "event") return "Calendar";
  if (home?.trim()) return home.trim();
  const counts = new Map<string, number>();
  for (const n of notes) {
    if ((foldedPropStr(n.props, "type") ?? "").toLowerCase() !== foldedType) continue;
    counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0];
  return best?.[0] ?? "";
}
