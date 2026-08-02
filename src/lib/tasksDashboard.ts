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

export interface TasksDashboardRow {
  path: string;
  title: string;
  area: string;
  priority: string | null;
  priorityWeight: number;
  created: string | null;
  ageDays: number | null;
  /** Deterministic rot rank: whole-day age × priority weight (high 3,
      medium 2, low/unknown 1). Missing dates have a score of zero. */
  score: number;
  stale: boolean;
  finding: "stale" | "undated" | null;
  /** Pinned to the hand-picked Now section (SUB-786). */
  now: boolean;
}

export interface TasksDashboardGroup {
  area: string;
  rows: TasksDashboardRow[];
}

export interface TasksDashboardModel {
  config: TasksDashboardConfig;
  /** The hand-picked focus list (`now: true`), cross-area, above the groups. */
  nowRows: TasksDashboardRow[];
  groups: TasksDashboardGroup[];
  /** Visible open tasks: Now rows plus grouped Later rows. */
  total: number;
  /** Findings among LATER rows only — a pinned task is already chosen, so it
      never counts as needing attention (SUB-786). */
  attention: number;
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

/** Whole local-calendar days since a strict YYYY-MM-DD value. Invalid,
    missing, and non-string values return null; future dates clamp to zero. */
export function taskAgeDays(value: unknown, now: Date): number | null {
  const raw = clean(value);
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || Number.isNaN(now.getTime())) return null;
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
  // whole-day age by one.
  const createdOrdinal = Date.UTC(year, month - 1, day);
  const todayOrdinal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.floor((todayOrdinal - createdOrdinal) / 86_400_000));
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
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || Number.isNaN(now.getTime())) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = new Date(year, month - 1, day);
  if (
    stamp.getFullYear() !== year ||
    stamp.getMonth() !== month - 1 ||
    stamp.getDate() !== day
  )
    return false;
  const untilOrdinal = Date.UTC(year, month - 1, day);
  const todayOrdinal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return untilOrdinal > todayOrdinal;
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

const compareText = (a: string, b: string): number => {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA < lowerB) return -1;
  if (lowerA > lowerB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

function compareRows(a: TasksDashboardRow, b: TasksDashboardRow): number {
  return (
    b.score - a.score ||
    (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
    b.priorityWeight - a.priorityWeight ||
    compareText(a.title, b.title) ||
    compareText(a.path, b.path)
  );
}

/** Build the read-only tasks surface from the note index. Neither the notes
    array nor any note/props object is mutated. */
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
  let snoozed = 0;

  for (const note of notes) {
    if (clean(note.props.type)?.toLowerCase() !== "task") continue;
    const status = clean(note.props.status) ?? undefined;
    if (isComplete(status)) continue;

    const sourceArea = clean(note.props.area) ?? "Unassigned";
    const area = allowed ? allowed.get(sourceArea.toLowerCase()) : sourceArea;
    if (!area) continue;

    if (taskIsSnoozed(note.props.snoozed_until, now)) {
      snoozed += 1;
      continue;
    }

    const ageDays = taskAgeDays(note.props.created, now);
    const priority = clean(note.props.priority);
    const priorityWeight = taskPriorityWeight(priority);
    const stale = ageDays !== null && ageDays >= config.staleDays;
    const isNow = taskIsNow(note.props.now);
    rows.push({
      path: note.path,
      title: note.title,
      area,
      priority,
      priorityWeight,
      created: clean(note.props.created),
      ageDays,
      score: (ageDays ?? 0) * priorityWeight,
      stale,
      // a pinned task carries no finding: Now is the chosen list, and rot
      // chips there would just re-shame decisions already made
      finding: isNow ? null : ageDays === null ? "undated" : stale ? "stale" : null,
      now: isNow,
    });
  }

  // Now is cross-area but keeps the same deterministic order as the groups,
  // so pinning never shuffles rows relative to each other.
  const nowRows = rows.filter((row) => row.now).sort(compareRows);

  const grouped = new Map<string, TasksDashboardRow[]>();
  for (const row of rows) {
    if (row.now) continue;
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
  const groups = areaOrder.map((area) => ({
    area,
    rows: [...(grouped.get(area) ?? [])].sort(compareRows),
  }));

  return {
    config,
    nowRows,
    groups,
    total: rows.length,
    attention: rows.filter((row) => row.finding !== null).length,
    snoozed,
  };
}
