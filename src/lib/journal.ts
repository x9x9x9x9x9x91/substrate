/* Daily notes: a journal entry is a plain note at
   `Journal/YYYY-MM-DD.md`. ISO date plumbing lives in ./dates — this adds
   only the journal-specific pieces. */

import { isIsoDate } from "./dates.ts";
import type { NoteMeta } from "./types.ts";

export const JOURNAL_DIR = "Journal";

const DAILY_RE = new RegExp(`^${JOURNAL_DIR}/(\\d{4}-\\d{2}-\\d{2})\\.md$`);

export function dailyPath(date: string): string {
  return `${JOURNAL_DIR}/${date}.md`;
}

/** The date a path journals, or null when it isn't a daily note. A date that
    doesn't exist on the calendar (2026-02-30) is just a note. */
export function dailyDateOf(path: string): string | null {
  const m = DAILY_RE.exec(path);
  return m && isIsoDate(m[1]) ? m[1] : null;
}

const HUMAN = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** "2026-07-17" → "Friday, 17 July 2026" — the journal title wants the full
    weekday form; date props keep dates.ts's short format. */
export function humanDate(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  return HUMAN.format(new Date(y, mo - 1, d));
}

const HUMAN_SHORT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "2026-07-17" → "Fri, 17 Jul 2026" — list-density form of humanDate. */
export function humanDateShort(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  return HUMAN_SHORT.format(new Date(y, mo - 1, d));
}

/** List/card display title: daily notes read as dates, never raw stems. */
export function displayTitle(n: Pick<NoteMeta, "path" | "title">): string {
  const date = dailyDateOf(n.path);
  return date ? humanDateShort(date) : n.title;
}

/** Journal folder order: daily notes newest-first by filename date,
    non-daily strays after by updated_ms desc. Returns a new array. */
export function journalOrder(notes: NoteMeta[]): NoteMeta[] {
  const daily: { note: NoteMeta; date: string }[] = [];
  const rest: NoteMeta[] = [];
  for (const note of notes) {
    const date = dailyDateOf(note.path);
    if (date) daily.push({ note, date });
    else rest.push(note);
  }
  daily.sort((a, b) => b.date.localeCompare(a.date));
  rest.sort((a, b) => b.updated_ms - a.updated_ms);
  return daily.map((d) => d.note).concat(rest);
}
