/* The Today surface's data: one pure pass over the vault snapshot
   shaping the day-agenda decision surface — what's Scheduled today, what's
   Due & overdue, what's been Picked for today, and what's already Done. The
   one verb is Pick: it
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

/** The mark naming the day's ONE headline. Deliberately not date-shaped:
    an ISO value on an undeclared prop lands on the calendar (the pick's own
    free visibility), and a headline is not a second appointment. It means
    something only while the note is picked for today — a mark left on a note
    that fell off the day is inert until the note is picked again. */
export const FOCUS_PROP = "focus";

/** Does this note carry the headline mark? */
export function isFocused(n: NoteMeta): boolean {
  const raw = foldedPropStr(n.props, FOCUS_PROP);
  return raw === "true" || raw === "yes";
}

/** The state every Pick surface reads to decide its label. The
    pane is no longer the only place the verb lives — the row menu, the open
    note's ⋯ menu and the palette all ask this same question about the note
    in hand, so "picked" means one thing everywhere. */
export function isPickedToday(n: NoteMeta, today: string): boolean {
  return pickedDay(n) === today;
}

/** How many suggestions the add box offers at once. Small on purpose: the
    line is a capture field, not a search surface — a reader scans a handful
    and otherwise keeps typing the new thought. */
export const SUGGEST_LIMIT = 7;

/** Open tasks whose title contains what has been typed. The definition of an
    open task is the Tasks board's own (`type: task`, status not complete), so
    the line can never offer something that surface calls finished. Notes
    already picked for today are out — picking one again is a no-op, and a
    committed row belongs in the Picked lane, not in the suggestions above it.

    A snoozed task IS offered, though the Tasks board parks it out of sight
    until its wake day. Deliberate, and the same call every other surface
    makes: a snooze says "not on the board today", not "not a task" — and a
    reader who types its title is asking for that exact task by name, which is
    a stronger signal than the parking.

    Ordering puts titles that START with the query first: a reader typing
    "mix" means the task called "Mix bounce" before the one called "Remix
    notes". Ties fall back to the title, so the list never reorders under a
    keystroke that changed nothing. */
export function suggestOpenTasks(
  notes: readonly NoteMeta[],
  query: string,
  today: string,
  limit = SUGGEST_LIMIT
): NoteMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: NoteMeta[] = [];
  for (const n of notes) {
    // the title test first: it rejects most of a vault on a plain substring
    // check, before anything has to fold a prop
    if (!n.title.toLowerCase().includes(q)) continue;
    if (foldedPropStr(n.props, "type")?.trim().toLowerCase() !== "task") continue;
    if (isComplete(foldedPropStr(n.props, "status")?.trim())) continue;
    if (isPickedToday(n, today)) continue;
    hits.push(n);
  }
  hits.sort((a, b) => {
    const ap = a.title.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.title.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.title.localeCompare(b.title) || a.path.localeCompare(b.path);
  });
  return hits.slice(0, Math.max(0, limit));
}

export interface PickedItem {
  note: NoteMeta;
  /** the note's earliest timed entry today from its OTHER date props (a
      picked 14:00 call stays a 14:00 call); absent = all-day */
  time?: string;
  /** the day's headline — at most one picked item ever carries it */
  focused?: boolean;
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
      then today's. Complete or repeating past ones never nag */
  due: AgendaItem[];
  /** today's deadline entries already finished — the payoff, kept off the
      due lane so a done thing never reads as overdue clutter */
  done: AgendaItem[];
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
  const done: AgendaItem[] = [];
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
      // a finished deadline is the day's payoff, not a decision: it leaves
      // the due lane for its own section instead of sitting there dimmed,
      // where the dim read as leftover clutter. Other kinds of entry keep
      // their scheduled slot when complete — a cancelled gig still says
      // something about the shape of the day
      const lane = deadline ? (isComplete(e.status) ? done : due) : scheduled;
      lane.push({ ...e, deadline });
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
  done.sort(agendaOrder);

  for (const p of picked) {
    const t = timeByPath.get(p.note.path);
    if (t) p.time = t;
  }
  // the headline sits on top, whatever its time; everything else keeps the
  // agenda's order. Extra marks are demoted rather than shown: a day has one
  // headline by definition, so a second mark left by a stale write must not
  // render as a second one
  for (const p of picked) if (isFocused(p.note)) p.focused = true;
  picked.sort(
    (a, b) =>
      Number(b.focused ?? false) - Number(a.focused ?? false) ||
      (a.time ?? "").localeCompare(b.time ?? "") ||
      a.note.title.localeCompare(b.note.title)
  );
  for (let i = 1; i < picked.length; i++) picked[i].focused = false;
  leftovers.sort((a, b) => b.day.localeCompare(a.day) || a.note.title.localeCompare(b.note.title));

  return { today, title: todayTitle(today), scheduled, due, done, picked, leftovers };
}
