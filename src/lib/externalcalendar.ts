import { addDays, isoDay, parseDay } from "./calendar.ts";
import type { ExternalCalendarEvent } from "./types.ts";

/** One occupied day of a read-only external occurrence. Multi-day events are
    segmented exactly like vault ranges so the month grid can join them. */
export interface ExternalCalEntry extends ExternalCalendarEvent {
  day: string;
  time?: string;
  spanPos?: "start" | "mid" | "end";
}

export function externalEntries(events: ExternalCalendarEvent[]): ExternalCalEntry[] {
  const out: ExternalCalEntry[] = [];
  for (const event of events) {
    const first = parseDay(event.startDay);
    const last = parseDay(event.endDay ?? event.startDay);
    if (!first || !last || last.getTime() < first.getTime()) continue;
    const spans = event.endDay !== null && event.endDay !== event.startDay;
    for (let day = first, i = 0; day.getTime() <= last.getTime(); day = addDays(day, 1), i++) {
      const current = isoDay(day);
      const final = current === event.endDay;
      out.push({
        ...event,
        day: current,
        // A timed multi-day event only owns the start time on its first day.
        ...(i === 0 && event.startTime ? { time: event.startTime } : {}),
        ...(spans ? { spanPos: i === 0 ? "start" : final ? "end" : "mid" } : {}),
      });
    }
  }
  return out;
}

export function compareExternalTime(a: ExternalCalEntry, b: ExternalCalEntry): number {
  return (a.time ?? "").localeCompare(b.time ?? "") || a.title.localeCompare(b.title);
}
