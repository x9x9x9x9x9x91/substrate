import { isComplete } from "./calendar.ts";
import { byFoldedKey } from "./schemalookup.ts";
import { foldedPropKey, foldedPropStr, type NoteMeta } from "./types.ts";

/** `stale_days` is deliberately conservative: a task gets a full month before
    age alone raises it from the quiet layer. Dashboard frontmatter can opt into
    a shorter positive whole-day threshold. */
export const DEFAULT_TASK_STALE_DAYS = 30;

export interface TasksDashboardConfig {
  /** null means every area; an empty supplied list means no areas */
  areas: string[] | null;
  /** the resolved threshold, always a positive whole number of days */
  staleDays: number;
  /** whether age findings render on this board at all: the global
      Settings default, overridden to on by a board that sets its own
      `stale_days`. Per-note `stale: never` still wins over both. */
  staleChips: boolean;
  view: TasksView;
  sort: TasksSort;
}

/** How the board renders: the sectioned urgency list, or a kanban
    board with one column per area. */
export type TasksView = "list" | "board";

/** The within-section (and within-column) ordering. `urgency` is the default:
    due bucket, then priority, then age. The others lead with one
    dimension and keep the rest as tiebreakers. */
export type TasksSort = "urgency" | "priority" | "due" | "age";

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
  /** Pinned to the hand-picked Now section. */
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

/** One kanban column: an area and every visible row in it. Unlike the list's
    sections, urgency never pulls a row out of its column — the column IS the
    category, and Overdue/Now live on as chip state inside the cards. */
export interface TasksBoardColumn {
  area: string;
  rows: TasksDashboardRow[];
}

export interface TasksDashboardModel {
  config: TasksDashboardConfig;
  /** The list view's spine, in render order: Overdue, Due today, Now, then
      the area groups. Empty sections are omitted entirely. */
  sections: TasksDashboardSection[];
  /** The board view: one column per area, in the same order the area groups
      take. With an allowlist every listed area gets a column even when empty
      (a drop target); without one, only areas that hold rows appear. */
  columns: TasksBoardColumn[];
  /** Parked rows, soonest wake first — the collapsed Snoozed section. */
  snoozedRows: TasksDashboardRow[];
  /** Visible open tasks across every section (snoozed rows excluded). */
  total: number;
  overdue: number;
  dueToday: number;
  nowCount: number;
  /** Open tasks hidden by a future `snoozed_until` (after the area filter). */
  snoozed: number;
  /** Open tasks the `areas:` allowlist excluded. Zero without an allowlist.
      An empty board means two different things and this is what tells them
      apart: nothing open anywhere, or a filter that matched none of the work
      there is. */
  filtered: number;
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

/** The board's own threshold, or null when it doesn't set a usable one. The
    null carries meaning beyond the fallback: a board that names a
    threshold has asked for age chips, so it keeps them even when the global
    Settings toggle is off. An unreadable value is a typo, not a request —
    it reads as unset, and the resolved threshold falls back to 30. */
function parseStaleDays(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** The persisted view/sort props, folded like every other config value; an
    unknown or missing value falls back to the default rather than erroring —
    a hand-typed frontmatter typo must never blank the board. */
export function parseTasksView(value: unknown): TasksView {
  return clean(value)?.toLowerCase() === "board" ? "board" : "list";
}

export function parseTasksSort(value: unknown): TasksSort {
  switch (clean(value)?.toLowerCase()) {
    case "priority":
      return "priority";
    case "due":
      return "due";
    case "age":
      return "age";
    default:
      return "urgency";
  }
}

/** `staleChipsDefault` is the global Settings toggle, on unless
    Settings.md turns it off. It is a DEFAULT: a board with its own
    `stale_days` has asked for age chips explicitly and keeps them. */
export function tasksDashboardConfig(
  props: Record<string, unknown>,
  staleChipsDefault = true
): TasksDashboardConfig {
  const staleDays = parseStaleDays(byFoldedKey(props, "stale_days"));
  return {
    areas: parseAreas(byFoldedKey(props, "areas")),
    staleDays: staleDays ?? DEFAULT_TASK_STALE_DAYS,
    staleChips: staleDays !== null || staleChipsDefault,
    view: parseTasksView(byFoldedKey(props, "view")),
    sort: parseTasksSort(byFoldedKey(props, "sort")),
  };
}

/** The calendar day a date-ish prop names, or null. A bare `YYYY-MM-DD` and a
    timed `YYYY-MM-DD HH:MM` both resolve to their day; anything else
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
    urgent and never drop it (the trust rule, now covering `due`). */
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

/** `stale: never` on a task note exempts it from age findings for good
    — some notes just aren't touched, and a rot chip on one is
    noise about a decision already made, exactly like a pinned Now row. A
    boolean/string `false` reads the same way, since that is how the key gets
    typed by hand. Anything else — including a typo and including `true` — is
    ignored and the task ages normally: an unreadable value must never error,
    and must never be the thing that silently hides rot. */
export function taskStaleExempt(value: unknown): boolean {
  if (value === false) return true;
  const v = clean(value)?.toLowerCase();
  return v === "never" || v === "false";
}

/** A task is snoozed while `snoozed_until` is a strict future YYYY-MM-DD
    (local calendar). Today or past means awake; malformed values never hide
    a task — a bad date silently vanishing a row would be the worst failure
    shape for a trust surface. */
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

/** Soonest due first; undated rows sort after every dated one — a row with
    no deadline can't outrank one that has one on a due-led ordering. */
const dueRank = (row: TasksDashboardRow): number =>
  row.dueDays === null ? Number.MAX_SAFE_INTEGER : row.dueDays;

/** The stable tail every ordering ends on, so input order never changes the
    board (the determinism rule, kept across all four sorts). */
const compareTail = (a: TasksDashboardRow, b: TasksDashboardRow): number =>
  compareText(a.title, b.title) || compareText(a.path, b.path);

/** The four orderings behind the sort switch. `urgency` is the
    default — due bucket, then priority, then age. The others promote one
    dimension to the front and keep the remaining ones as tiebreakers, so
    switching sorts re-ranks rather than shuffles. */
function rowComparator(sort: TasksSort): (a: TasksDashboardRow, b: TasksDashboardRow) => number {
  switch (sort) {
    case "priority":
      return (a, b) =>
        b.priorityWeight - a.priorityWeight ||
        bucketRank(a) - bucketRank(b) ||
        (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
        compareTail(a, b);
    case "due":
      return (a, b) =>
        dueRank(a) - dueRank(b) ||
        b.priorityWeight - a.priorityWeight ||
        (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
        compareTail(a, b);
    case "age":
      return (a, b) =>
        (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
        bucketRank(a) - bucketRank(b) ||
        b.priorityWeight - a.priorityWeight ||
        compareTail(a, b);
    case "urgency":
      return (a, b) =>
        bucketRank(a) - bucketRank(b) ||
        b.priorityWeight - a.priorityWeight ||
        (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
        compareTail(a, b);
  }
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
  now = new Date(),
  staleChipsDefault = true
): TasksDashboardModel {
  const config = tasksDashboardConfig(dashboardProps, staleChipsDefault);
  const allowed = config.areas
    ? new Map(config.areas.map((area) => [area.toLowerCase(), area]))
    : null;
  const rows: TasksDashboardRow[] = [];
  const snoozedRows: TasksDashboardRow[] = [];
  let filtered = 0;
  const foldedProp = (props: Record<string, unknown>, key: string) =>
    props[foldedPropKey(props, key)];

  for (const note of notes) {
    if (clean(foldedPropStr(note.props, "type"))?.toLowerCase() !== "task") continue;
    const status = clean(foldedPropStr(note.props, "status")) ?? undefined;
    if (isComplete(status)) continue;

    const sourceArea = clean(foldedPropStr(note.props, "area")) ?? "Unassigned";
    const area = allowed ? allowed.get(sourceArea.toLowerCase()) : sourceArea;
    if (!area) {
      filtered += 1;
      continue;
    }

    const created = foldedPropStr(note.props, "created");
    const due = foldedPropStr(note.props, "due");
    const priority = clean(foldedPropStr(note.props, "priority"));
    const ageDays = taskAgeDays(created, now);
    // whether age is a diagnostic for THIS task: off globally, or
    // exempted on the note itself. `stale` follows the same gate as the chip
    // so the flag never claims rot the board deliberately isn't reporting.
    const ages = config.staleChips && !taskStaleExempt(foldedProp(note.props, "stale"));
    const stale = ages && ageDays !== null && ageDays >= config.staleDays;
    const isNow = taskIsNow(foldedProp(note.props, "now"));
    const dueDays = taskDueDays(due, now);
    const row: TasksDashboardRow = {
      path: note.path,
      title: note.title,
      area,
      priority,
      priorityWeight: taskPriorityWeight(priority),
      created: clean(created),
      ageDays,
      due: dueDays === null ? null : (dayPart(due)?.iso ?? null),
      dueDays,
      dueBucket: taskDueBucket(dueDays),
      stale,
      // a pinned task carries no finding: Now is the chosen list, and rot
      // chips there would just re-shame decisions already made. `undated`
      // rides the same switch as `stale` — both are age diagnostics, and a
      // board (or a note) that has opted out of age wants neither.
      finding: isNow || !ages ? null : ageDays === null ? "undated" : stale ? "stale" : null,
      now: isNow,
      snoozedUntil: null,
    };

    const snoozedUntil = foldedPropStr(note.props, "snoozed_until");
    if (taskIsSnoozed(snoozedUntil, now)) {
      snoozedRows.push({ ...row, snoozedUntil: dayPart(snoozedUntil)?.iso ?? null });
      continue;
    }
    rows.push(row);
  }

  const compareRows = rowComparator(config.sort);

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

  // The kanban columns regroup EVERY visible row by area — urgency never
  // relocates a card the way it claims a list row for Overdue/Today/Now.
  // With an allowlist each listed area keeps a column even when empty (it is
  // a drop target); without one only populated areas appear.
  const byArea = new Map<string, TasksDashboardRow[]>();
  for (const row of rows) {
    const col = byArea.get(row.area) ?? [];
    col.push(row);
    byArea.set(row.area, col);
  }
  const columnOrder = config.areas
    ? config.areas
    : [...byArea.keys()].sort((a, b) => {
        if (a === "Unassigned") return 1;
        if (b === "Unassigned") return -1;
        return compareText(a, b);
      });
  const columns: TasksBoardColumn[] = columnOrder.map((area) => ({
    area,
    rows: [...(byArea.get(area) ?? [])].sort(compareRows),
  }));

  return {
    config,
    sections,
    columns,
    snoozedRows: snoozedRows.sort(compareSnoozed),
    total: rows.length,
    overdue: overdueRows.length,
    dueToday: todayRows.length,
    nowCount: nowRows.length,
    snoozed: snoozedRows.length,
    filtered,
  };
}
