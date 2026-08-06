/* The Today surface's data: one pure pass over the vault snapshot
   shaping the day-agenda decision surface — what's Scheduled today, what's
   Due & overdue, and what's been Picked for today. The one verb is Pick: it
   writes an ordinary date prop (`today: YYYY-MM-DD`) on the note, so
   persistence, query, and calendar visibility ride the existing date-prop
   machinery. A stale pick (yesterday or older) surfaces as a leftover for a
   keep-or-clear decision — never silently carried. The pane stays a dumb
   renderer; this module is the unit-tested half. */

import type { NoteMeta, SchemaConfig } from "./types.ts";
import { foldedPropStr } from "./types.ts";
import {
  calendarEntries,
  compareEntryTime,
  entryEndDay,
  isComplete,
  isDeadline,
  parseDay,
  splitDayTime,
} from "./calendar.ts";
import type { AgendaItem } from "./agenda.ts";

const WEEKDAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Friday, July 18" — the pane's confident date header. */
export function todayTitle(iso: string): string {
  const d = parseDay(iso);
  if (!d) return iso;
  return `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}`;
}

/** The prop a pick writes. Nothing schema-side reserves it: an undeclared
    ISO-shaped date value still lands on the calendar (the heuristic every
    surface shares), which is exactly the free visibility the pick wants. */
export const TODAY_PROP = "today";

/** The day a note is picked for, when its `today` prop carries a valid day —
    an optional time parses but never keys the pick. */
export function pickedDay(n: NoteMeta): string | null {
  const raw = foldedPropStr(n.props, TODAY_PROP);
  if (!raw) return null;
  return splitDayTime(raw)?.day ?? null;
}

/** The state every Pick surface reads to decide its label. The
    pane is no longer the only place the verb lives — the row menu, the open
    note's ⋯ menu and the palette all ask this same question about the note
    in hand, so "picked" means one thing everywhere. */
export function isPickedToday(n: NoteMeta, today: string): boolean {
  return pickedDay(n) === today;
}

export interface PickedItem {
  note: NoteMeta;
  /** the note's earliest timed entry today from its OTHER date props (a
      picked 14:00 call stays a 14:00 call); absent = all-day */
  time?: string;
}

export interface LeftoverItem {
  note: NoteMeta;
  /** the stale day the note stays picked for, YYYY-MM-DD < today */
  day: string;
}

export interface TodayData {
  today: string;
  /** "Friday, July 18" */
  title: string;
  /** today's non-deadline calendar entries, in order (all-day, then
      timed ascending) — picked notes and the pick prop itself stay out */
  scheduled: AgendaItem[];
  /** deadline entries needing the decision: overdue first (oldest first),
      then today's. Complete today-items ride along for the dimmed payoff;
      complete or repeating past ones never nag */
  due: AgendaItem[];
  /** notes whose `today` prop is today — the committed agenda */
  picked: PickedItem[];
  /** notes whose `today` prop is stale (yesterday or older), freshest first */
  leftovers: LeftoverItem[];
}

/** Everything the Today pane shows, derived from the same vault snapshot the
    rest of the app renders. Read-only display data apart from the one verb:
    the pane mutates only through the `today` prop write. */
export function todayData(notes: NoteMeta[], schema: SchemaConfig, today: string): TodayData {
  // partition notes by their pick day: today → the committed lane, past →
  // leftovers, future → a deliberate calendar placement, not this surface's
  // business
  const pickedPaths = new Set<string>();
  const picked: PickedItem[] = [];
  const leftovers: LeftoverItem[] = [];
  for (const n of notes) {
    const day = pickedDay(n);
    if (!day) continue;
    if (day === today) {
      pickedPaths.add(n.path);
      picked.push({ note: n });
    } else if (day < today) {
      leftovers.push({ note: n, day });
    }
  }

  // one calendar pass over [today, today]: non-repeating entries ignore the
  // window, so every past deadline shows; a series expands only inside it,
  // which is why a repeating entry never counts as overdue
  const scheduled: AgendaItem[] = [];
  const due: AgendaItem[] = [];
  const timeByPath = new Map<string, string>();
  for (const e of calendarEntries(notes, schema, { start: today, end: today })) {
    // the pick prop never feeds the candidate lanes — its entry IS the pick
    if (e.prop.toLowerCase() === TODAY_PROP) continue;
    if (e.day === today && e.time) {
      const cur = timeByPath.get(e.path);
      if (cur === undefined || e.time < cur) timeByPath.set(e.path, e.time);
    }
    // a picked note's other entries moved lanes with it — no double rows
    if (pickedPaths.has(e.path)) continue;
    const deadline = isDeadline(schema, e.type, e.prop);
    if (e.day === today) {
      (deadline ? due : scheduled).push({ ...e, deadline });
      // a range still running is not overdue — its today-row above
      // already carries it
    } else if (
      e.day < today &&
      entryEndDay(e) < today &&
      deadline &&
      !e.repeating &&
      !isComplete(e.status)
    ) {
      due.push({ ...e, deadline });
    }
  }

  // lanes keep the agenda's order: all-day first, then timed ascending,
  // title as the tiebreak; the due lane fronts its overdue rows
  // oldest-first, today's deadlines after
  const agendaOrder = (a: AgendaItem, b: AgendaItem) =>
    compareEntryTime(a, b) || a.title.localeCompare(b.title) || a.prop.localeCompare(b.prop);
  scheduled.sort(agendaOrder);
  due.sort((a, b) => a.day.localeCompare(b.day) || agendaOrder(a, b));

  for (const p of picked) {
    const t = timeByPath.get(p.note.path);
    if (t) p.time = t;
  }
  picked.sort(
    (a, b) =>
      (a.time ?? "").localeCompare(b.time ?? "") || a.note.title.localeCompare(b.note.title)
  );
  leftovers.sort((a, b) => b.day.localeCompare(a.day) || a.note.title.localeCompare(b.note.title));

  return { today, title: todayTitle(today), scheduled, due, picked, leftovers };
}
