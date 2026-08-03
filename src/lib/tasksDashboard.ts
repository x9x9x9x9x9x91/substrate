import { isComplete } from "./calendar.ts";
import type { NoteMeta } from "./types.ts";

/** `stale_days` is deliberately conservative: a task gets a full month before
    age alone raises it from the quiet layer. Dashboard frontmatter can opt into
    a shorter positive whole-day threshold. */
export const DEFAULT_TASK_STALE_DAYS = 30;

export interface TasksDashboardConfig {
  /** null means every area; an empty supplied list means no areas */
  areas: string[] | null;
  staleDays: number;
}

/** Where a task's `due` puts it relative to today's local calendar day.
    `null` = no usable due date, which is an ordinary state, not a finding. */
export type TaskDueBucket = "overdue" | "today" | "upcoming";

export interface TasksDashboardRow {
  path: string;
  title: string;
  area: string;
  priority: string | null;
  priorityWeight: number;
  created: string | null;
  ageDays: number | null;
  /** The day part of a usable `due`, or null. A malformed value reads as
      no due date rather than hiding or mis-bucketing the row. */
  due: string | null;
  /** Whole local-calendar days until `due`; negative = overdue, 0 = today. */
  dueDays: number | null;
  dueBucket: TaskDueBucket | null;
  stale: boolean;
  /** Secondary diagnostics, never the row's reason for being on the board. */
  finding: "stale" | "undated" | null;
  /** Pinned to the hand-picked Now section (SUB-786). */
  now: boolean;
  /** The wake day, on snoozed rows only. */
  snoozedUntil: string | null;
}

export type TaskSectionKind = "overdue" | "today" | "now" | "area";

export interface TasksDashboardSection {
  kind: TaskSectionKind;
  /** "Overdue" / "Due today" / "Now", or the area's own name. */
  label: string;
  rows: TasksDashboardRow[];
}

export interface TasksDashboardModel {
  config: TasksDashboardConfig;
  /** The board's spine, in render order: Overdue, Due today, Now, then the
      area groups. Empty sections are omitted entirely. */
  sections: TasksDashboardSection[];
  /** Parked rows, soonest wake first — the collapsed Snoozed section. */
  snoozedRows: TasksDashboardRow[];
  /** Visible open tasks across every section (snoozed rows excluded). */
  total: number;
  overdue: number;
  dueToday: number;
  nowCount: number;
  /** Open tasks hidden by a future `snoozed_until` (after the area filter). */
  snoozed: number;
}

const clean = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function parseAreas(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const areas: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const area = clean(item);
    if (!area) continue;
    const key = area.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      areas.push(area);
    }
  }
  return areas;
}

function parseStaleDays(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TASK_STALE_DAYS;
}

export function tasksDashboardConfig(props: Record<string, unknown>): TasksDashboardConfig {
  return {
    areas: parseAreas(props.areas),
    staleDays: parseStaleDays(props.stale_days),
  };
}

/** The calendar day a date-ish prop names, or null. A bare `YYYY-MM-DD` and a
    timed `YYYY-MM-DD HH:MM` (SUB-270) both resolve to their day; anything else
    — including an impossible date like 2026-02-30 — is null. */
function dayPart(value: unknown): { iso: string; ordinal: number } | null {
  const raw = clean(value);
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = new Date(year, month - 1, day);
  if (
    stamp.getFullYear() !== year ||
    stamp.getMonth() !== month - 1 ||
    stamp.getDate() !== day
  )
    return null;
  // UTC ordinals over local date parts avoid 23/25-hour DST days changing a
  // whole-day difference by one.
  return { iso: `${match[1]}-${match[2]}-${match[3]}`, ordinal: Date.UTC(year, month - 1, day) };
}

const todayOrdinal = (now: Date): number | null =>
  Number.isNaN(now.getTime())
    ? null
    : Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

/** Whole local-calendar days since a strict YYYY-MM-DD value. Invalid,
    missing, and non-string values return null; future dates clamp to zero.
    `created` stays strict-day only: a timed created date has never been part
    of the contract, and age is a rot signal, not a schedule. */
export function taskAgeDays(value: unknown, now: Date): number | null {
  const raw = clean(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const day = dayPart(raw);
  const today = todayOrdinal(now);
  if (!day || today === null) return null;
  return Math.max(0, Math.floor((today - day.ordinal) / 86_400_000));
}

/** Whole local-calendar days until `due`: negative is overdue, 0 is today,
    positive is upcoming. Malformed and missing values return null — an
    unreadable due date must leave the row where it was, never bucket it as
    urgent and never drop it (the SUB-786 trust rule, now covering `due`). */
export function taskDueDays(value: unknown, now: Date): number | null {
  const day = dayPart(value);
  const today = todayOrdinal(now);
  if (!day || today === null) return null;
  return Math.floor((day.ordinal - today) / 86_400_000);
}

export function taskDueBucket(dueDays: number | null): TaskDueBucket | null {
  if (dueDays === null) return null;
  return dueDays < 0 ? "overdue" : dueDays === 0 ? "today" : "upcoming";
}

/** YAML `now: true` arrives as a boolean from the engine or as the string
    "true" through prop round-trips; both count. Anything else is off. */
export function taskIsNow(value: unknown): boolean {
  return value === true || clean(value)?.toLowerCase() === "true";
}

/** A task is snoozed while `snoozed_until` is a strict future YYYY-MM-DD
    (local calendar). Today or past means awake; malformed values never hide
    a task — a bad date silently vanishing a row would be the worst failure
    shape for a trust surface (SUB-786). */
export function taskIsSnoozed(value: unknown, now: Date): boolean {
  const raw = clean(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = dayPart(raw);
  const today = todayOrdinal(now);
  if (!day || today === null) return false;
  return day.ordinal > today;
}

export function taskPriorityWeight(value: unknown): number {
  switch (clean(value)?.toLowerCase()) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

/** The option-color name a priority wears when the vault's schema doesn't
    define one for the `priority` prop — the same closed `--opt-*` roster
    every other tinted value uses, so a schema-less vault still reads
    urgency-first. A schema color always wins over this. */
export function priorityFallbackColor(value: unknown): string | undefined {
  switch (clean(value)?.toLowerCase()) {
    case "high":
      return "red";
    case "medium":
      return "yellow";
    case "low":
      return "gray";
    default:
      return undefined;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The compact due/wake label: "Today" for the day itself, "15 Jun" inside
    this year, "15 Jun 27" beyond it. Unparseable days pass through. */
export function dueChipLabel(iso: string, dueDays: number | null, now: Date): string {
  if (dueDays === 0) return "Today";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return iso;
  const day = Number(m[3]);
  const year = Number(m[1]);
  const thisYear = !Number.isNaN(now.getTime()) && year === now.getFullYear();
  return thisYear ? `${day} ${month}` : `${day} ${month} ${String(year).slice(2)}`;
}

const compareText = (a: string, b: string): number => {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA < lowerB) return -1;
  if (lowerA > lowerB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const BUCKET_RANK: Record<TaskDueBucket, number> = { overdue: 0, today: 1, upcoming: 2 };
const bucketRank = (row: TasksDashboardRow): number =>
  row.dueBucket === null ? 3 : BUCKET_RANK[row.dueBucket];

/** Urgency first (SUB-870): due bucket, then priority, then age. Rot — which
    used to be the whole ordering — is now only the tiebreaker between two
    equally urgent, equally important tasks. */
function compareRows(a: TasksDashboardRow, b: TasksDashboardRow): number {
  return (
    bucketRank(a) - bucketRank(b) ||
    b.priorityWeight - a.priorityWeight ||
    (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
    compareText(a.title, b.title) ||
    compareText(a.path, b.path)
  );
}

/** Soonest wake first, so the collapsed Snoozed section reads as a queue. */
function compareSnoozed(a: TasksDashboardRow, b: TasksDashboardRow): number {
  return (
    compareText(a.snoozedUntil ?? "", b.snoozedUntil ?? "") ||
    compareText(a.title, b.title) ||
    compareText(a.path, b.path)
  );
}

/** Build the tasks surface from the note index. Neither the notes array nor
    any note/props object is mutated. */
export function buildTasksDashboard(
  notes: readonly NoteMeta[],
  dashboardProps: Record<string, unknown>,
  now = new Date()
): TasksDashboardModel {
  const config = tasksDashboardConfig(dashboardProps);
  const allowed = config.areas
    ? new Map(config.areas.map((area) => [area.toLowerCase(), area]))
    : null;
  const rows: TasksDashboardRow[] = [];
  const snoozedRows: TasksDashboardRow[] = [];

  for (const note of notes) {
    if (clean(note.props.type)?.toLowerCase() !== "task") continue;
    const status = clean(note.props.status) ?? undefined;
    if (isComplete(status)) continue;

    const sourceArea = clean(note.props.area) ?? "Unassigned";
    const area = allowed ? allowed.get(sourceArea.toLowerCase()) : sourceArea;
    if (!area) continue;

    const ageDays = taskAgeDays(note.props.created, now);
    const priority = clean(note.props.priority);
    const stale = ageDays !== null && ageDays >= config.staleDays;
    const isNow = taskIsNow(note.props.now);
    const dueDays = taskDueDays(note.props.due, now);
    const row: TasksDashboardRow = {
      path: note.path,
      title: note.title,
      area,
      priority,
      priorityWeight: taskPriorityWeight(priority),
      created: clean(note.props.created),
      ageDays,
      due: dueDays === null ? null : (dayPart(note.props.due)?.iso ?? null),
      dueDays,
      dueBucket: taskDueBucket(dueDays),
      stale,
      // a pinned task carries no finding: Now is the chosen list, and rot
      // chips there would just re-shame decisions already made
      finding: isNow ? null : ageDays === null ? "undated" : stale ? "stale" : null,
      now: isNow,
      snoozedUntil: null,
    };

    if (taskIsSnoozed(note.props.snoozed_until, now)) {
      snoozedRows.push({ ...row, snoozedUntil: dayPart(note.props.snoozed_until)?.iso ?? null });
      continue;
    }
    rows.push(row);
  }

  // Urgency outranks the pin: a task that is late is late whether or not the
  // user pinned it, and the board's promise is that its top is what's due. A
  // pinned row reaches Now only while it isn't overdue or due today.
  const overdueRows = rows.filter((row) => row.dueBucket === "overdue").sort(compareRows);
  const todayRows = rows.filter((row) => row.dueBucket === "today").sort(compareRows);
  const nowRows = rows
    .filter((row) => row.now && row.dueBucket !== "overdue" && row.dueBucket !== "today")
    .sort(compareRows);
  const sectioned = new Set([...overdueRows, ...todayRows, ...nowRows]);

  const grouped = new Map<string, TasksDashboardRow[]>();
  for (const row of rows) {
    if (sectioned.has(row)) continue;
    const group = grouped.get(row.area) ?? [];
    group.push(row);
    grouped.set(row.area, group);
  }

  const areaOrder = config.areas
    ? config.areas.filter((area) => grouped.has(area))
    : [...grouped.keys()].sort((a, b) => {
        if (a === "Unassigned") return 1;
        if (b === "Unassigned") return -1;
        return compareText(a, b);
      });

  const sections: TasksDashboardSection[] = [];
  if (overdueRows.length > 0)
    sections.push({ kind: "overdue", label: "Overdue", rows: overdueRows });
  if (todayRows.length > 0) sections.push({ kind: "today", label: "Due today", rows: todayRows });
  if (nowRows.length > 0) sections.push({ kind: "now", label: "Now", rows: nowRows });
  for (const area of areaOrder)
    sections.push({
      kind: "area",
      label: area,
      rows: [...(grouped.get(area) ?? [])].sort(compareRows),
    });

  return {
    config,
    sections,
    snoozedRows: snoozedRows.sort(compareSnoozed),
    total: rows.length,
    overdue: overdueRows.length,
    dueToday: todayRows.length,
    nowCount: nowRows.length,
    snoozed: snoozedRows.length,
  };
}
