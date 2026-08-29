// The database pane's calendar layout: the rows a database is already
// showing, placed on a month grid by one of its date properties.
//
// Recurrence is NOT reimplemented here — the same standing rule the
// ```calendar fence states in its own header. A row's days come out of
// calendarEntries (src/lib/calendar.ts), so `repeat` / `repeat_until` /
// `repeat_skip` (vault-format §5.7) behave exactly as they do in the Calendar
// pane and in a dashboard fence: occurrences stay virtual and bounded by the
// rendered month's window.
//
// The grid helpers (sortEntries, entriesByDay, countEntriesInMonth,
// monthWindow) come from calendarfence.ts. They are month-grid helpers rather
// than fence logic — a second copy here would be the drift parity/ exists to
// prevent, so this layout reads the same ones the fence does.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { calendarEntries, isSchedulingProp, parseDay } from "./calendar.ts";
import type { CalEntry, CalWindow } from "./calendar.ts";
import { sortEntries } from "./calendarfence.ts";
import type { NoteMeta, PropSchema, SchemaConfig } from "./types.ts";

/** The date properties a database's calendar can bind to: every prop the
    schema declares as a date, plus every prop the rows actually carry a date
    on — in both halves, only the props that can mean scheduling at all.
    Schema-declared props lead in their declared order — a database that
    says what it is should not have its binding decided by whichever note was
    written first — and observed-only props follow in first-seen order. The
    spellings are the authored ones, never the folded lookup keys. */
export function dbDateProps(
  notes: NoteMeta[],
  typeSchema: Record<string, PropSchema>,
  schema: SchemaConfig
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const folded = name.toLowerCase();
    if (seen.has(folded)) return;
    seen.add(folded);
    out.push(name);
  };
  // a schema may declare `created` or `repeat_until` as a date and be right
  // about it — they are still not days a row happens on, and calendarEntries
  // would place nothing on them, so they are never offered as a binding
  for (const [prop, ps] of Object.entries(typeSchema)) {
    if (ps.kind === "date" && isSchedulingProp(prop)) add(prop);
  }
  // what the rows carry: calendarEntries already refuses the props that are
  // date-SHAPED but never scheduling (`created`, `repeat_until`, …), so
  // observing through it can't offer a binding the calendar would ignore
  for (const e of calendarEntries(notes, schema)) add(e.prop);
  return out;
}

/** The prop this calendar actually places rows on: the pref's binding when it
    still names an available date prop (folded, so a note's alternate casing
    doesn't strand the pref), else the first one offered, else null — a
    database with no date property has no calendar to draw. */
export function calendarDateProp(
  pref: string | undefined,
  available: string[]
): string | null {
  if (pref) {
    const want = pref.toLowerCase();
    const match = available.find((p) => p.toLowerCase() === want);
    if (match) return match;
  }
  return available[0] ?? null;
}

/** The grid entries for one month of a database's calendar: the pane's own
    rows (already filtered and query-narrowed by the pane), expanded through
    calendarEntries inside `window` and kept to the bound date prop. Sorted the
    way every other calendar surface sorts — day, then time-of-day, then
    title. */
export function dbLayoutEntries(
  rows: NoteMeta[],
  schema: SchemaConfig,
  dateProp: string | null,
  window: CalWindow
): CalEntry[] {
  if (!dateProp) return [];
  const want = dateProp.toLowerCase();
  return sortEntries(
    calendarEntries(rows, schema, window).filter((e) => e.prop.toLowerCase() === want)
  );
}

/** The day a row made while the calendar layout is showing is born on: the
    day the reader is looking at. Today when the visible month is the month
    today falls in, else that month's first day — a month grid says "here is
    where new things go", and a row with no date lands nowhere in it.

    Day-precision on purpose: a date value's time is optional everywhere the
    grid parses one, so an all-day value places correctly whether or not the
    property's other rows carry times. */
export function calendarSeedDay(year: number, month0: number, todayIso: string): string {
  const today = parseDay(todayIso);
  if (today && today.getFullYear() === year && today.getMonth() === month0) return todayIso;
  return `${String(year).padStart(4, "0")}-${String(month0 + 1).padStart(2, "0")}-01`;
}
