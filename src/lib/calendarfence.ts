// Calendar fences: a ```calendar fence inside a dashboard note draws
// one month grid over any database date property. Config stays hand-editable
// key: value text (portable), exactly like the ```chart fence next to it:
//
//   ```calendar
//   source: release            # a database type, or {{Sheet Name}} for a sheet
//   date: released             # the date property the grid places notes on
//   label: title               # optional — what each chip reads (default: title)
//   query: status:unreleased   # optional — the filter-bar language
//   ```
//
// Recurrence is NOT reimplemented here: a database source expands through
// calendarEntries (src/lib/calendar.ts), so `repeat` / `repeat_until` /
// `repeat_skip` (vault-format §5.7) behave exactly as they do in the Calendar
// pane — occurrences stay virtual and bounded by the rendered month's window.
// A sheet source has no notes and therefore no recurrence: one row, one day.
//
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import { calendarEntries, compareEntryTime, isoDay, monthGridDays } from "./calendar.ts";
import type { CalEntry, CalWindow } from "./calendar.ts";
import { dateOf, sheetRows } from "./chart.ts";
import type { ChartRow } from "./chart.ts";
import { hasUnclosedFence } from "./fences.ts";
import { typeSchemaFor } from "./schemalookup.ts";
import type { SheetEval, SheetModel } from "./sheet.ts";
import { filterByQuery } from "./views.ts";
import { foldedPropStr } from "./types.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

export type CalendarSource = { kind: "db"; type: string } | { kind: "sheet"; name: string };

export interface CalendarConfig {
  source: CalendarSource;
  /** the date property (database) or column (sheet) days come from */
  date: string;
  /** the property/column each chip reads; absent = the note title / first column */
  label: string | null;
  /** filter-bar query narrowing a database source; never set on a sheet */
  query: string | null;
}

/** One parsed ```calendar fence: either a valid config or a human-readable error. */
export interface CalendarBlock {
  config: CalendarConfig | null;
  error: string | null;
}

/** Derived grid entries, or the one error the fence shows in place. */
export interface CalendarData {
  entries: CalEntry[];
  error: string | null;
}

const KNOWN_KEYS = new Set(["source", "date", "label", "query"]);

function parseSource(v: string): CalendarSource {
  const m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(v);
  if (m) return { kind: "sheet", name: m[1] };
  if (!v) throw new Error("source must be a database or {{Sheet Name}}");
  return { kind: "db", type: v };
}

/** Parse one fence body; throws on any malformed line or missing key. The
    strict half of the ```chart convention — the collector below turns the
    throw into a per-fence error card, so one bad fence never touches its
    siblings. */
export function parseCalendarConfig(inner: string): CalendarConfig {
  const kv = new Map<string, string>();
  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(line);
    if (!m) throw new Error(`can't parse line: ${line}`);
    const key = m[1].toLowerCase();
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown key "${m[1]}"`);
    kv.set(key, m[2].trim());
  }
  if (!kv.has("source")) throw new Error(`missing required key "source"`);
  if (!kv.has("date")) throw new Error(`missing required key "date"`);
  const source = parseSource(kv.get("source") as string);
  const date = (kv.get("date") as string).trim();
  if (!date) throw new Error("date must name a date property");
  const label = kv.get("label")?.trim() || null;
  const query = kv.get("query")?.trim() || null;
  // a sheet is rows and formulas, not a database — there is no filter bar
  // language to apply to it, so a `query:` there is a typo, not a silent no-op
  if (query !== null && source.kind === "sheet") {
    throw new Error("query only applies to a database source");
  }
  return { source, date, label, query };
}

/** All ```calendar fences in a note body, in order. Never throws.

    A trailing space on the opener (```calendar␠) opens the fence like the
    bare form — the commonest hand-typed slip, and refusing it drew a board of
    zero calendars over a note that plainly holds one. */
export function parseCalendarBlocks(body: string): CalendarBlock[] {
  const re = /```calendar[ \t]*\r?\n([\s\S]*?)```/g;
  const out: CalendarBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    try {
      out.push({ config: parseCalendarConfig(m[1]), error: null });
    } catch (e) {
      out.push({ config: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // an opener with no closing line matched nothing above, so the board would
  // have counted zero and said nothing; the fence gets a banner instead
  if (hasUnclosedFence(body, "calendar"))
    out.push({ config: null, error: "This ```calendar fence is never closed — add a closing ``` line so the calendar can be read." });

  return out;
}

/** The inclusive day window a month grid covers — the leading/trailing days of
    the adjacent months included, since they are drawn. Recurrence MUST be
    expanded against this: calendarEntries with no window emits a series' anchor
    only, so a windowless grid would show one instance of a daily note. */
export function monthWindow(year: number, month0: number): CalWindow {
  const days = monthGridDays(year, month0);
  return { start: isoDay(days[0]), end: isoDay(days[days.length - 1]) };
}

function sourceLabel(source: CalendarSource): string {
  return source.kind === "sheet" ? source.name : source.type;
}

function fieldNoun(source: CalendarSource): string {
  return source.kind === "sheet" ? "column" : "property";
}

/** Named error when a bound property is absent from every note/row of the
    source — the fence's own "no property “dew” on release (has: due, …)"
    instead of a silently empty grid. */
function missing(
  source: CalendarSource,
  prop: string,
  present: Map<string, string>,
  adjective = ""
): string {
  const noun = `${adjective}${fieldNoun(source)}`;
  const has = [...present.values()];
  const tail = has.length ? `(has: ${has.join(", ")})` : `(it has no ${noun.trim()}s)`;
  return `no ${noun} “${prop}” on ${sourceLabel(source)} ${tail}`;
}

/** Folded key → authored spelling, first seen wins — errors read back the
    author's own casing rather than the folded lookup key. */
function presentProps(notes: NoteMeta[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of notes) {
    for (const k of Object.keys(n.props)) if (!out.has(k.toLowerCase())) out.set(k.toLowerCase(), k);
  }
  return out;
}

function withLabel(e: CalEntry, note: NoteMeta | undefined, label: string | null): CalEntry {
  if (!label || !note) return e;
  const v = foldedPropStr(note.props, label)?.trim();
  // an empty label on one note is not an error — the title is the honest
  // fallback, and the binding check already caught a label nobody carries
  return v ? { ...e, title: v } : e;
}

/** Grid entries for a database source. `window` is the month grid's own span:
    recurrence (vault-format §5.7) expands inside it through
    calendarEntries — this module never re-derives a cadence. */
export function dbCalendarEntries(
  config: CalendarConfig,
  notes: NoteMeta[],
  schema: SchemaConfig,
  window: CalWindow
): CalendarData {
  if (config.source.kind !== "db") return { entries: [], error: null };
  const type = config.source.type;
  const folded = type.toLowerCase();
  const ofType = notes.filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === folded);
  // a database is real when the schema knows it or a note carries the type —
  // anything else is a typo (embeds.ts' rule, same words)
  const declared = typeSchemaFor(schema, type);
  if (declared === undefined && ofType.length === 0) {
    return { entries: [], error: `no database “${type}”` };
  }
  const typeSchema = declared ?? {};
  if (ofType.length > 0) {
    // bind against the whole type, never the query result: an over-narrow
    // filter must read as an empty month, not as a misspelled property
    const wanted = config.date.toLowerCase();
    const dateProps = new Map<string, string>();
    for (const e of calendarEntries(ofType, schema)) {
      if (!dateProps.has(e.prop.toLowerCase())) dateProps.set(e.prop.toLowerCase(), e.prop);
    }
    const declaredDate = Object.entries(typeSchema).some(
      ([k, v]) => k.toLowerCase() === wanted && v.kind === "date"
    );
    if (!declaredDate && !dateProps.has(wanted)) {
      return { entries: [], error: missing(config.source, config.date, dateProps, "date ") };
    }
    if (config.label) {
      const props = presentProps(ofType);
      if (config.label.toLowerCase() !== "title" && !props.has(config.label.toLowerCase())) {
        return { entries: [], error: missing(config.source, config.label, props) };
      }
    }
  }
  const matched = config.query ? filterByQuery(ofType, config.query, undefined, typeSchema) : ofType;
  const byPath = new Map(matched.map((n) => [n.path, n]));
  const wanted = config.date.toLowerCase();
  const entries = calendarEntries(matched, schema, window)
    .filter((e) => e.prop.toLowerCase() === wanted)
    .map((e) => withLabel(e, byPath.get(e.path), config.label));
  return { entries: sortEntries(entries), error: null };
}

function cellText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // FErr and any structured cell have no honest scalar form
  return "";
}

/** Grid entries for a `{{Sheet}}` source: one row, one day. Sheet rows are not
    notes, so there is no recurrence and no per-row target — every chip opens
    the sheet itself at `path`. A row whose date cell is not date-shaped is
    simply not placed. */
export function sheetCalendarEntries(
  config: CalendarConfig,
  path: string,
  model: SheetModel,
  ev: SheetEval
): CalendarData {
  if (config.source.kind !== "sheet") return { entries: [], error: null };
  const rows: ChartRow[] = sheetRows(model, ev);
  // sheetRows folds its keys, so the names come off the model instead — the
  // author reads back their own header casing
  const present = new Map<string, string>();
  for (const h of [...model.headers, ...ev.computed.map((c) => c.name)]) {
    if (!present.has(h.toLowerCase())) present.set(h.toLowerCase(), h);
  }
  if (rows.length > 0) {
    if (!present.has(config.date.toLowerCase())) {
      return { entries: [], error: missing(config.source, config.date, present, "date ") };
    }
    if (config.label && !present.has(config.label.toLowerCase())) {
      return { entries: [], error: missing(config.source, config.label, present) };
    }
  }
  const dateKey = config.date.toLowerCase();
  // a sheet has no title column; absent an explicit label the first column is
  // the row's name, which is how every sheet is actually laid out
  const labelKey = (config.label ?? model.headers[0] ?? "").toLowerCase();
  const entries: CalEntry[] = [];
  for (const row of rows) {
    const day = dateOf(cellText(row[dateKey]));
    if (!day) continue;
    const title = cellText(row[labelKey]).trim() || config.source.name;
    entries.push({ path, title, type: "", prop: config.date, day });
  }
  return { entries: sortEntries(entries), error: null };
}

/** Stable render order: by day, then by time-of-day, then by title — the same
    ordering the Calendar pane's day cells use. */
export function sortEntries(entries: CalEntry[]): CalEntry[] {
  return [...entries].sort(
    (a, b) => a.day.localeCompare(b.day) || compareEntryTime(a, b) || a.title.localeCompare(b.title)
  );
}

/** How many of `entries` land in the calendar month itself — what the fence
    foot means by "this month". Neither entry source is month-scoped: a db
    source's non-repeating notes come back whatever the grid's window says
    (calendarEntries only bounds spans and recurrence), and a sheet source
    takes no window at all, so a 40-row sheet would otherwise read "40 entries
    this month" in every month. The adjacent-month cells the
    grid draws are deliberately NOT counted: the month named in the heading is
    the month the number is about. */
export function countEntriesInMonth(entries: CalEntry[], year: number, month0: number): number {
  const prefix = `${year}-${String(month0 + 1).padStart(2, "0")}-`;
  return entries.filter((e) => e.day.startsWith(prefix)).length;
}

/** Entries bucketed by ISO day, for the grid's cells. */
export function entriesByDay(entries: CalEntry[]): Map<string, CalEntry[]> {
  const out = new Map<string, CalEntry[]>();
  for (const e of entries) {
    const bucket = out.get(e.day);
    if (bucket) bucket.push(e);
    else out.set(e.day, [e]);
  }
  return out;
}

/** Heading for the fence, derived from its source and date binding. */
export function calendarTitle(c: CalendarConfig): string {
  const src = sourceLabel(c.source);
  return `${src.charAt(0).toUpperCase()}${src.slice(1)} by ${c.date}`;
}

/** Provenance line for the fence foot. */
export function calendarSourceDesc(c: CalendarConfig): string {
  return c.source.kind === "db" ? `database: ${c.source.type}` : `sheet: ${c.source.name}`;
}
