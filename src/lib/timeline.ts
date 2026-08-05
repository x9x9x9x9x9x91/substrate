// Timeline fences: strict hand-authored config plus pure database-to-lane
// derivation. The renderer stays deliberately thin; date validity, query
// semantics, missing bindings and overlap packing are testable here.

import { daysBetween, formatDateHuman, isIsoDate, MONTHS, shiftDate, toIso } from "./dates.ts";
import { filterByQuery } from "./views.ts";
import { foldedObjectKey, typeSchemaFor } from "./schemalookup.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { foldedPropStr } from "./types.ts";

export interface TimelineConfig {
  source: string;
  start: string;
  end: string | null;
  label: string;
  group: string | null;
  query: string;
}

export interface TimelineItem {
  path: string;
  label: string;
  group: string | null;
  start: string;
  end: string | null;
}

export interface TimelineLaneItem extends TimelineItem {
  track: number;
  left: number;
  width: number;
}

export interface TimelineLane {
  key: string;
  label: string | null;
  tracks: number;
  items: TimelineLaneItem[];
}

export interface TimelineTick {
  date: string;
  label: string;
  left: number;
}

export interface TimelineLayout {
  start: string;
  end: string;
  days: number;
  lanes: TimelineLane[];
  ticks: TimelineTick[];
  today: number | null;
}

export interface TimelineData {
  items: TimelineItem[];
  skipped: number;
  error: string | null;
}

const KNOWN_KEYS = new Set(["source", "start", "end", "label", "group", "query"]);
/** An ISO day, optionally carrying a clock time. The tail is anchored: a
 * date-time ("2026-08-04T10:00", "2026-08-04 10:30") still reads as its day,
 * but a typo'd day ("2026-08-045", "2026-08-04abc") is not silently truncated
 * to a false-but-plausible position on the axis. */
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d.*)?$/;

/** Parse one timeline fence body. Unknown keys are errors: a typo should not
 * silently produce a plausible but wrong schedule. */
export function parseTimelineConfig(inner: string): TimelineConfig {
  const kv = new Map<string, string>();
  for (const raw of inner.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`can't parse line: ${line}`);
    const key = match[1].toLowerCase();
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown key "${match[1]}"`);
    kv.set(key, match[2].trim());
  }
  for (const key of ["source", "start", "label"]) {
    if (!kv.get(key)) throw new Error(`missing required key "${key}"`);
  }
  const source = kv.get("source")!;
  if (/^\{\{.*\}\}$/.test(source)) {
    throw new Error("timeline source must be a database type");
  }
  return {
    source,
    start: kv.get("start")!,
    end: kv.get("end") || null,
    label: kv.get("label")!,
    group: kv.get("group") || null,
    query: kv.get("query") ?? "",
  };
}

/** Leading ISO day of a date or date-time prop. */
export function timelineDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = DATE_PREFIX.exec(raw.trim());
  return match && isIsoDate(match[1]) ? match[1] : null;
}

function valueFor(note: NoteMeta, prop: string): string | undefined {
  return prop.toLowerCase() === "title" ? note.title : foldedPropStr(note.props, prop);
}

/** Date bindings are scalar. A multi/relation list beginning with an ISO day
 * must not silently become the first date on the axis. */
function dateValueFor(note: NoteMeta, prop: string): string | undefined {
  const key = foldedObjectKey(note.props, prop);
  const value = key === undefined ? undefined : note.props[key];
  return typeof value === "string" ? value : undefined;
}

/** Did the author actually write a value here? An empty list counts as blank,
 * not as an unparseable date — `end: []` means milestone, `start: []` means
 * undated, and neither belongs in the skipped count. */
function hasWrittenValue(note: NoteMeta, prop: string): boolean {
  const key = foldedObjectKey(note.props, prop);
  if (key === undefined) return false;
  const value = note.props[key];
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}

function presentProp(
  notes: NoteMeta[],
  prop: string,
  typeSchema: ReturnType<typeof typeSchemaFor>
): boolean {
  return (
    prop.toLowerCase() === "title" ||
    foldedObjectKey(typeSchema, prop) !== undefined ||
    notes.some((note) => valueFor(note, prop) !== undefined)
  );
}

/** Resolve one database source with the shared query language. Missing end is
 * a milestone; malformed written dates are skipped and counted rather than
 * drawn at a false position. */
export function timelineData(
  config: TimelineConfig,
  notes: NoteMeta[],
  schema: SchemaConfig
): TimelineData {
  const type = config.source.toLowerCase();
  const ofType = notes.filter(
    (note) => foldedPropStr(note.props, "type")?.toLowerCase() === type
  );
  const typeSchema = typeSchemaFor(schema, config.source);
  if (typeSchema === undefined && ofType.length === 0) {
    return { items: [], skipped: 0, error: `Unknown database “${config.source}”` };
  }
  const bindings = [config.start, config.label, config.end, config.group].filter(
    (value): value is string => value !== null
  );
  const missing = bindings.filter((prop) => !presentProp(ofType, prop, typeSchema));
  if (missing.length > 0 && ofType.length > 0) {
    return {
      items: [],
      skipped: 0,
      error: `no ${missing.length === 1 ? "property" : "properties"} ${missing
        .map((prop) => `“${prop}”`)
        .join(" or ")} on ${config.source}`,
    };
  }
  const matched = config.query.trim()
    ? filterByQuery(ofType, config.query, undefined, typeSchema ?? {})
    : ofType;
  const items: TimelineItem[] = [];
  let skipped = 0;
  for (const note of matched) {
    const start = timelineDate(dateValueFor(note, config.start));
    if (!start) {
      skipped++;
      continue;
    }
    const endRaw = config.end ? dateValueFor(note, config.end) : undefined;
    const end = timelineDate(endRaw);
    const endWritten = config.end ? hasWrittenValue(note, config.end) : false;
    if ((endWritten && !end) || (end && end < start)) {
      skipped++;
      continue;
    }
    const label = valueFor(note, config.label)?.trim() || note.title;
    const group = config.group ? valueFor(note, config.group)?.trim() || "Other" : null;
    items.push({ path: note.path, label, group, start, end });
  }
  items.sort(
    (a, b) =>
      (a.group ?? "").localeCompare(b.group ?? "") ||
      a.start.localeCompare(b.start) ||
      a.label.localeCompare(b.label)
  );
  return { items, skipped, error: null };
}

function pct(axisStart: string, days: number, date: string): number {
  return (daysBetween(axisStart, date) / days) * 100;
}

function firstOfNextMonth(iso: string): string {
  const [year, month] = iso.split("-").map(Number);
  return toIso(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1);
}

function addMonths(iso: string, count: number): string {
  const [year, month] = iso.split("-").map(Number);
  const zero = year * 12 + (month - 1) + count;
  return toIso(Math.floor(zero / 12), (zero % 12) + 1, 1);
}

type TickUnit = "day" | "week" | "fortnight" | "month" | "quarter" | "year";

/** Coarsest-last. Selection walks this in order, so the axis always uses the
 * finest unit that still fits the label budget. */
const TICK_UNITS: TickUnit[] = ["day", "week", "fortnight", "month", "quarter", "year"];
/** Labels are ~60px wide on a 680px min-width canvas; past this they collide. */
const MAX_TICKS = 14;
/** Below this an axis stops reading as a scale, so a unit this sparse is only
 * used when nothing finer fits. */
const MIN_TICKS = 3;

/** First Monday on or after `iso`. */
function nextMonday(iso: string): string {
  return shiftDate(iso, (8 - new Date(`${iso}T12:00:00`).getDay()) % 7);
}

function ticksForUnit(start: string, end: string, unit: TickUnit): Omit<TimelineTick, "left">[] {
  const out: Omit<TimelineTick, "left">[] = [];
  if (unit === "day" || unit === "week" || unit === "fortnight") {
    const stride = unit === "day" ? 1 : unit === "week" ? 7 : 14;
    let cursor = unit === "day" ? start : nextMonday(start);
    while (cursor <= end) {
      const [, month, day] = cursor.split("-").map(Number);
      out.push({ date: cursor, label: `${MONTHS[month - 1]} ${day}` });
      cursor = shiftDate(cursor, stride);
    }
    return out;
  }
  const step = unit === "month" ? 1 : unit === "quarter" ? 3 : 12;
  let cursor = firstOfNextMonth(start);
  if (step > 1) {
    // Land on real quarter/year boundaries rather than wherever the span began.
    const month = Number(cursor.split("-")[1]);
    cursor = addMonths(cursor, (step - ((month - 1) % step)) % step);
  }
  for (; cursor <= end; cursor = addMonths(cursor, step)) {
    const [year, month] = cursor.split("-").map(Number);
    const label =
      unit === "year"
        ? `${year}`
        : unit === "quarter"
          ? `${MONTHS[month - 1]} ${year}`
          : `${MONTHS[month - 1]}${month === 1 ? ` ${year}` : ""}`;
    out.push({ date: cursor, label });
  }
  return out;
}

/** Sparse, honest axis ticks. The unit is chosen mechanically — the finest of
 * day/week/fortnight/month/quarter/year whose count fits the label budget — so
 * density degrades smoothly instead of cliffing from ten weekly ticks to two
 * monthly ones a day later. */
export function timelineTicks(start: string, end: string): TimelineTick[] {
  const days = Math.max(1, daysBetween(start, end));
  const fitting = TICK_UNITS.map((unit) => ticksForUnit(start, end, unit)).filter(
    (ticks) => ticks.length <= MAX_TICKS
  );
  // Past a few decades even yearly ticks overflow the budget, so thin them to
  // every 2nd/5th/10th… year rather than printing a solid bar of labels.
  const years = ticksForUnit(start, end, "year");
  const stride = Math.ceil(years.length / MAX_TICKS);
  const chosen =
    fitting.find((ticks) => ticks.length >= MIN_TICKS) ??
    fitting[0] ??
    years.filter((_, index) => index % stride === 0);
  return chosen.map((tick) => ({ ...tick, left: pct(start, days, tick.date) }));
}

/** Pack overlapping items into subtracks inside each authored group. */
export function layoutTimeline(items: TimelineItem[], today: string): TimelineLayout | null {
  if (items.length === 0) return null;
  const first = items.reduce((min, item) => (item.start < min ? item.start : min), items[0].start);
  const last = items.reduce((max, item) => {
    const edge = item.end ?? item.start;
    return edge > max ? edge : max;
  }, items[0].end ?? items[0].start);
  const rawDays = Math.max(1, daysBetween(first, last));
  const pad = Math.min(14, Math.max(1, Math.ceil(rawDays * 0.04)));
  const start = shiftDate(first, -pad);
  const end = shiftDate(last, pad);
  const days = Math.max(1, daysBetween(start, end));
  const grouped = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = item.group ?? "";
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }
  const lanes: TimelineLane[] = [];
  for (const [key, laneItems] of grouped) {
    const trackEnds: string[] = [];
    const laid = laneItems.map((item): TimelineLaneItem => {
      const edge = item.end ?? item.start;
      let track = trackEnds.findIndex((prior) => prior < item.start);
      if (track < 0) {
        track = trackEnds.length;
        trackEnds.push(edge);
      } else {
        trackEnds[track] = edge;
      }
      const left = pct(start, days, item.start);
      const width = item.end
        ? Math.max(0.8, (daysBetween(item.start, item.end) + 1) / days * 100)
        : 0;
      return { ...item, track, left, width };
    });
    lanes.push({ key, label: key || null, tracks: trackEnds.length, items: laid });
  }
  const todayPos = today >= start && today <= end ? pct(start, days, today) : null;
  return { start, end, days, lanes, ticks: timelineTicks(start, end), today: todayPos };
}

export function timelineItemLabel(item: TimelineItem): string {
  const dates = item.end
    ? `${formatDateHuman(item.start)} – ${formatDateHuman(item.end)}`
    : formatDateHuman(item.start);
  return `${item.label} · ${dates}`;
}
