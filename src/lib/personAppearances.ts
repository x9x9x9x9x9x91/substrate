/* Where a person turns up: the mentions rail on a person note, built by
   matching that person's handles against the rest of the vault.

   Named for the person rather than for "appearances" alone because
   `appearance.ts` sits one letter away and means something else entirely —
   the look of the app, glow and accent tone. Two files whose names differed
   by an `s` were a standing invitation to import the wrong one. */

import { entriesForNote } from "./calendar.ts";
import { propValues } from "./query.ts";
import type { FullSearchHit, NoteMeta, SchemaConfig } from "./types.ts";
import { foldedPropKey, foldedTypeName, FUNCTIONAL_TYPES } from "./types.ts";

/** The frontmatter key a person note carries: the identifiers that person
    answers to — emails, phone numbers, @names — typed once, by hand. */
const HANDLES_KEY = "handles";

/** Props that never count as an appearance, however handle-shaped their value:
    `handles` itself is the other person note's identity list (two people
    sharing an address is a duplicate to resolve, not an appearance), and
    `created`/`updated` are the app's own stamps. */
const NOT_AN_APPEARANCE = new Set([HANDLES_KEY, "created", "updated"]);

export type AppearanceKind = "event" | "row" | "mention";

/** One place the person shows up, computed — never written anywhere. */
export interface Appearance {
  kind: AppearanceKind;
  path: string;
  title: string;
  /** the handle that matched, in the person note's own spelling */
  handle: string;
  /** the matched note's database type; "" for untyped notes */
  dbType: string;
  /** the frontmatter key that carried the handle — absent on mentions,
      which matched body text rather than a column */
  prop?: string;
  /** local day of the calendar entry, YYYY-MM-DD — events only */
  day?: string;
  /** the entry's time-of-day, HH:MM — events only, absent = all-day */
  time?: string;
}

/** One section of the rail. `key` is stable for React; `label` names the
    section ("Calendar", "Releases", "Mentions") without its count, which the
    renderer appends. */
export interface AppearanceGroup {
  key: string;
  kind: AppearanceKind;
  label: string;
  entries: Appearance[];
}

/** Case and outer whitespace carry no meaning in a hand-typed address; nothing
    else is normalized. Matching stays exact on purpose — `+49 170 …` and
    `+49170…` are two handles, and the fix is to list both, never a fuzzy rule
    that quietly merges two people. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** One prop value's individual handles: a comma-separated cell holds several,
    on the person note (`handles: a@b.com, +49…`) and on the column it matches
    alike, so both sides split the same way before the exact comparison. */
function splitHandles(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Does the note declare a `handles:` key at all — even an empty one? The
    empty case is what tells the rail to explain itself rather than stay
    invisible on a person note whose handles are still unfilled. */
export function hasHandlesKey(props: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(props, foldedPropKey(props, HANDLES_KEY));
}

/** The person note's handles in the author's own spelling, deduplicated by
    the normalized form, order preserved. Empty for a note without the key,
    with an empty value, or with a value that is only separators. */
export function noteHandles(props: Record<string, unknown>): string[] {
  const raw = props[foldedPropKey(props, HANDLES_KEY)];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    for (const handle of splitHandles(value)) {
      const key = normalizeHandle(handle);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(handle);
    }
  }
  return out;
}

/** A note is scannable when it is not the person note itself, not sealed, and
    not app machinery. Sealed is the load-bearing one: a sealed note's props
    are stripped in the index, and a derived rail must not resurrect them from
    a live unlock either — the seal wins, always. */
function scannable(note: NoteMeta, selfPath: string): boolean {
  if (note.path === selfPath) return false;
  if (note.sealed) return false;
  return !FUNCTIONAL_TYPES.has(foldedTypeName(note.props) ?? "");
}

/** The first prop on this note whose value is exactly one of the handles,
    in frontmatter order. Null when nothing matches. */
function matchedProp(
  note: NoteMeta,
  handleByNormal: Map<string, string>
): { prop: string; handle: string } | null {
  for (const key of Object.keys(note.props)) {
    if (NOT_AN_APPEARANCE.has(key.toLowerCase())) continue;
    for (const value of propValues(note, key)) {
      for (const piece of splitHandles(value)) {
        const handle = handleByNormal.get(normalizeHandle(piece));
        if (handle !== undefined) return { prop: key, handle };
      }
    }
  }
  return null;
}

/** One `matchedProp` pass over the whole vault, keyed by path — the event and
    row lanes ask the same question of the same notes, and the full rail runs
    both. Scannability is re-checked in each lane, so a note missing here is
    simply "no column matched". */
type PropMatches = ReadonlyMap<string, { prop: string; handle: string }>;

function structuralMatches(notes: NoteMeta[], handles: string[], selfPath: string): PropMatches {
  const index = handleIndex(handles);
  const out = new Map<string, { prop: string; handle: string }>();
  if (index.size === 0) return out;
  for (const note of notes) {
    if (!scannable(note, selfPath)) continue;
    const hit = matchedProp(note, index);
    if (hit) out.set(note.path, hit);
  }
  return out;
}

function handleIndex(handles: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const handle of handles) {
    const key = normalizeHandle(handle);
    if (key && !index.has(key)) index.set(key, handle);
  }
  return index;
}

/** Every note that names a handle in a frontmatter column AND is placed on the
    calendar by one of its date props — the dated half of the person's history.
    One appearance per note: a note on several days is one thing that happened,
    and the earliest day is when it started. */
export function eventAppearances(
  notes: NoteMeta[],
  handles: string[],
  selfPath: string,
  schema: SchemaConfig,
  matched?: PropMatches
): Appearance[] {
  const index = handleIndex(handles);
  if (index.size === 0) return [];
  const out: Appearance[] = [];
  for (const note of notes) {
    if (!scannable(note, selfPath)) continue;
    const hit = matched ? (matched.get(note.path) ?? null) : matchedProp(note, index);
    if (!hit) continue;
    const entries = entriesForNote(note, schema);
    if (entries.length === 0) continue;
    const first = [...entries].sort((a, b) => a.day.localeCompare(b.day))[0];
    out.push({
      kind: "event",
      path: note.path,
      title: note.title,
      handle: hit.handle,
      dbType: foldedTypeName(note.props) ?? "",
      prop: hit.prop,
      day: first.day,
      ...(first.time ? { time: first.time } : {}),
    });
  }
  // most recent first: a person page opens on what just happened
  return out.sort((a, b) => (b.day ?? "").localeCompare(a.day ?? "") || a.title.localeCompare(b.title));
}

/** Every note that names a handle in a frontmatter column and is not already
    an event — database rows (a release credit, a transaction counterparty) and
    plain notes carrying an `email:`-shaped prop. `taken` holds the paths the
    event pass already claimed. */
export function rowAppearances(
  notes: NoteMeta[],
  handles: string[],
  selfPath: string,
  taken: ReadonlySet<string> = new Set(),
  matched?: PropMatches
): Appearance[] {
  const index = handleIndex(handles);
  if (index.size === 0) return [];
  const out: Appearance[] = [];
  for (const note of notes) {
    if (!scannable(note, selfPath) || taken.has(note.path)) continue;
    const hit = matched ? (matched.get(note.path) ?? null) : matchedProp(note, index);
    if (!hit) continue;
    out.push({
      kind: "row",
      path: note.path,
      title: note.title,
      handle: hit.handle,
      dbType: foldedTypeName(note.props) ?? "",
      prop: hit.prop,
    });
  }
  return out.sort((a, b) => a.dbType.localeCompare(b.dbType) || a.title.localeCompare(b.title));
}

/** One parse group's text, rebuilt exactly. The backend's `parse_marked` cuts
    a single string into contiguous marked/unmarked slices, so the parts of one
    group concatenate back to the original text — joining them with a space
    would insert whitespace that was never typed, which is precisely how a
    multi-token handle (`+49 30 5550199`, matched as disjoint marked regions)
    stopped spelling itself out. */
function groupText(parts: { text: string }[]): string {
  return parts.map((part) => part.text).join("");
}

/** The searched text of one full-search hit, as SEPARATE groups — the title,
    (unless the hit is itself a person note) the matched prop values, and one
    per matched body line. Separate, because concatenating them would let a
    multi-word handle straddle a line break and count as a mention that nobody
    ever wrote. The index tokenizes, so a hit is a candidate, not a match: the
    handle has to survive the boundary check below inside ONE group.
    Known edge: a very long matched line comes back trimmed, so a handle sitting
    in the dropped part loses its mention — a false negative, never a false one.
    The prop group is one string by construction (the index space-joins every
    prop value into a single searched column), so a handle spanning two adjacent
    prop values is indistinguishable from one written in a single value. */
function hitTexts(hit: FullSearchHit, withProps: boolean): string[] {
  const groups = [groupText(hit.title_parts)];
  if (withProps) groups.push(groupText(hit.prop_parts));
  for (const match of hit.matches) groups.push(groupText(match.parts));
  return groups.map(normalizeHandle).filter((text) => text.length > 0);
}

/** Characters that continue a handle. A candidate flanked by one of these is
    part of a longer address rather than the handle itself: `@ivonne` is not
    `@ivo`, and `not-vesna@example.com` is not `vesna@example.com`. Letters and
    digits are Unicode-wide: with an ASCII-only class every non-Latin letter
    read as a boundary, so `иван` matched inside `иванов`. */
const HANDLE_CHAR = /[\p{L}\p{N}@_+-]/u;

/** The narrower "more address follows" test for a trailing dot. */
const ALNUM_CHAR = /[\p{L}\p{N}]/u;

/** Does this text spell the handle out on token boundaries? Both sides are
    already normalized. A trailing dot only blocks when it runs into more of an
    address (`…@example.com.au`), so a handle ending a sentence still counts. */
function spellsHandle(text: string, handle: string): boolean {
  if (!handle) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(handle, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1] : "";
    const end = at + handle.length;
    const after = text[end] ?? "";
    const openBefore = before === "" || (!HANDLE_CHAR.test(before) && before !== ".");
    const openAfter =
      after === "" ||
      (!HANDLE_CHAR.test(after) && !(after === "." && ALNUM_CHAR.test(text[end + 1] ?? "")));
    if (openBefore && openAfter) return true;
    from = at + 1;
  }
}

/** Notes whose body text spells a handle out, from a full-text search over
    each handle. Known edge: an ordinary code fence is body text like any other,
    so a handle inside one counts as a mention (only machine fences are stripped
    from the index). Notes already claimed as events or rows are dropped — the
    stronger, structural appearance is the one worth showing. `notes` supplies
    the metadata (title, sealed) the search hit does not carry; a hit whose
    path is unknown to the vault list is skipped rather than guessed at. */
export function mentionAppearances(
  hits: FullSearchHit[],
  notes: NoteMeta[],
  handles: string[],
  selfPath: string,
  taken: ReadonlySet<string> = new Set()
): Appearance[] {
  const index = handleIndex(handles);
  if (index.size === 0) return [];
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const seen = new Set<string>();
  const out: Appearance[] = [];
  for (const hit of hits) {
    if (taken.has(hit.path) || seen.has(hit.path)) continue;
    const note = byPath.get(hit.path);
    if (!note || !scannable(note, selfPath)) continue;
    // another person note's `handles:` column is a duplicate to resolve, not a
    // meeting — the row lane already excludes it, and so does this one
    const texts = hitTexts(hit, !hasHandlesKey(note.props));
    const handle = handles.find((candidate) => {
      const needle = normalizeHandle(candidate);
      return texts.some((text) => spellsHandle(text, needle));
    });
    if (handle === undefined) continue;
    seen.add(hit.path);
    out.push({
      kind: "mention",
      path: hit.path,
      title: note.title,
      handle,
      dbType: foldedTypeName(note.props) ?? "",
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** "3 releases" — the same naive plural the related rail uses. */
function pluralType(dbType: string, count: number): string {
  if (count === 1) return dbType;
  return dbType.endsWith("y") ? `${dbType.slice(0, -1)}ies` : `${dbType}s`;
}

function titleCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

export interface AppearanceInput {
  /** the person note whose page this is */
  self: NoteMeta;
  /** every note the vault list holds */
  notes: NoteMeta[];
  schema: SchemaConfig;
  /** full-search hits for the person's handles, when the mention lane has
      answered — absent or empty simply leaves the Mentions section out */
  searchHits?: FullSearchHit[];
}

/** The whole rail: calendar first, then one section per database, then plain
    mentions. Pure and read-only — nothing here writes to any note. A sealed
    person note has no handles to read (its props are stripped), so it computes
    to nothing on its own; the caller keeps the rail off it entirely. */
export function buildAppearances(input: AppearanceInput): AppearanceGroup[] {
  const { self, notes, schema, searchHits = [] } = input;
  if (self.sealed) return [];
  const handles = noteHandles(self.props);
  if (handles.length === 0) return [];

  // one prop scan feeds both structural lanes
  const matched = structuralMatches(notes, handles, self.path);
  const events = eventAppearances(notes, handles, self.path, schema, matched);
  const taken = new Set(events.map((e) => e.path));
  const rows = rowAppearances(notes, handles, self.path, taken, matched);
  for (const row of rows) taken.add(row.path);
  const mentions = mentionAppearances(searchHits, notes, handles, self.path, taken);

  const groups: AppearanceGroup[] = [];
  if (events.length > 0) {
    groups.push({ key: "event", kind: "event", label: "Calendar", entries: events });
  }
  const byType = new Map<string, Appearance[]>();
  for (const row of rows) {
    const bucket = byType.get(row.dbType);
    if (bucket) bucket.push(row);
    else byType.set(row.dbType, [row]);
  }
  for (const [dbType, entries] of [...byType.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  )) {
    groups.push({
      key: `row:${dbType}`,
      kind: "row",
      label: dbType ? titleCase(pluralType(dbType, entries.length)) : "Notes",
      entries,
    });
  }
  if (mentions.length > 0) {
    groups.push({ key: "mention", kind: "mention", label: "Mentions", entries: mentions });
  }
  return groups;
}
