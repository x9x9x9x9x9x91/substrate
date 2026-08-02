import type { NoteMeta, SchemaConfig } from "./types.ts";
import {
  calendarEntries,
  compareEntryTime,
  entryEndDay,
  isComplete,
  isDeadline,
  type CalEntry,
} from "./calendar.ts";

/* isDeadline's and isComplete's definitions moved to calendar.ts (SUB-206 /
   SUB-205 — the calendar's overdue helper shares both, and agenda already
   depends on calendar, so the dependency direction is unchanged); they stay
   part of this module's surface. */
export { isComplete, isDeadline };

/* Tray mini-agenda payload (SUB-30): what the menu-bar popover shows for one
   day. The query is SUB-14's calendar query wholesale — a note is an agenda
   row iff the calendar would show it that day. "Deadline" is SUB-21's
   notion: a date prop the schema flags `notify: true` (the same opt-in the
   due-date scheduler fires on), so a shipped release's past `released` date
   never counts as overdue. Complete entries (SUB-205) never count either. */

export interface AgendaItem extends CalEntry {
  /** true when this entry's prop is a schema-declared deadline */
  deadline: boolean;
}

export interface AgendaPayload {
  /** local day the payload describes, YYYY-MM-DD */
  today: string;
  /** everything dated today — plain entries first, deadlines after */
  items: AgendaItem[];
  /** deadlines whose day passed before today, complete ones excluded (SUB-205) */
  overdue: number;
}


/** The popover's contents for `today` (local YYYY-MM-DD): every note dated
    that day plus a count of passed deadlines. Read-only display data — the
    popover never mutates the vault. Recurrence (SUB-174) expands inside
    [today, today] so a series due today shows; a repeating entry never counts
    as overdue — a series always has a next occurrence. A complete entry
    (SUB-205) never counts either — done work stops nagging. */
export function agendaPayload(
  notes: NoteMeta[],
  schema: SchemaConfig,
  today: string
): AgendaPayload {
  const items: AgendaItem[] = [];
  let overdue = 0;
  // non-repeating entries ignore the window, so the overdue scan below still
  // sees every past deadline exactly as before
  for (const e of calendarEntries(notes, schema, { start: today, end: today })) {
    const deadline = isDeadline(schema, e.type, e.prop);
    if (e.day === today) items.push({ ...e, deadline });
    // a range is late only once its END has passed (SUB-596)
    else if (
      deadline &&
      e.day < today &&
      entryEndDay(e) < today &&
      !e.repeating &&
      !isComplete(e.status)
    )
      overdue += 1;
  }
  items.sort(
    (a, b) =>
      // all-day first, then timed ascending (SUB-270), then the classic order
      compareEntryTime(a, b) ||
      Number(a.deadline) - Number(b.deadline) ||
      a.title.localeCompare(b.title) ||
      a.prop.localeCompare(b.prop)
  );
  return { today, items, overdue };
}
