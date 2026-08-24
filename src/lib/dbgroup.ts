import type { NoteMeta, PropSchema, SelectOption } from "./types.ts";
import { foldedPropKey, foldedPropStr } from "./types.ts";
import { parseStrictNumber } from "./aggregate.ts";
import { canonicalColumn } from "./dbcolumns.ts";
import { byFoldedKey } from "./schemalookup.ts";

/** Does the schema call this column a number? — the one gate for
    numeric grouping, read the way `sortCmpFor` reads `kind === "number"`. */
function isNumberKey(key: string, typeSchema?: Record<string, PropSchema>): boolean {
  return byFoldedKey(typeSchema, key)?.kind === "number";
}

/** One section of a grouped view: the prop value its rows share, `null` for
    the "No <prop>" section of rows without a value. */
export interface NoteGroup {
  value: string | null;
  notes: NoteMeta[];
}

/** One note's group keys for a prop: a list value (YAML list of
    strings, e.g. hand-typed tags) contributes EACH item — the note belongs
    to group a AND group b — case-insensitively deduped so it never lands
    twice in one group. A scalar contributes its display string, exactly as
    before; a non-string list keeps propStr's joined JSON display. */
function propGroupValues(props: Record<string, unknown>, key: string): string[] {
  const v = props[foldedPropKey(props, key)];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of v) {
      const low = x.toLowerCase();
      if (x && !seen.has(low)) {
        seen.add(low);
        out.push(x);
      }
    }
    return out;
  }
  const s = foldedPropStr(props, key);
  return s ? [s] : [];
}

/** The bucket one group value falls in. Plain columns fold by casing, as
    they always have. A number-kind column folds by parsed VALUE —
    `1200` and `1200.00` are one section, not two — using the same
    `parseStrictNumber` coercion sort and the footer aggregates already agree
    with. A cell that isn't a number in a number column can't be bucketed by
    value; it keeps its own case-folded key, so junk stays visible instead of
    collapsing into one nameless heap. */
function groupKeyer(numeric: boolean): (v: string) => string {
  if (!numeric) return (v) => v.toLowerCase();
  return (v) => {
    const n = parseStrictNumber(v);
    return n === null ? v.toLowerCase() : `#${n}`;
  };
}

/** Case-insensitive bucketing of notes by one prop's group keys: values
    differing only in casing share a drain, value-less notes collect in
    `none`. `take(value)` empties the bucket matching `value`, so a schema
    option consumes its casing variants first and an option and a stray
    casing never split into two sections (shared by board + table grouping).
    A list-valued note sits in several buckets and can be taken into several
    groups — that is the point of per-item grouping. With `typeSchema` given,
    a number-kind prop buckets by numeric value. */
export function bucketByProp(
  notes: NoteMeta[],
  groupBy: string,
  typeSchema?: Record<string, PropSchema>
): { none: NoteMeta[]; take: (value: string) => NoteMeta[] } {
  const keyOf = groupKeyer(isNumberKey(groupBy, typeSchema));
  const byVal = new Map<string, NoteMeta[]>();
  const none: NoteMeta[] = [];
  for (const n of notes) {
    const vs = propGroupValues(n.props, groupBy);
    if (vs.length === 0) none.push(n);
    else for (const v of vs) byVal.set(keyOf(v), [...(byVal.get(keyOf(v)) ?? []), n]);
  }
  const take = (value: string): NoteMeta[] => {
    const k = keyOf(value);
    const bucket = byVal.get(k) ?? [];
    byVal.delete(k);
    return bucket;
  };
  return { none, take };
}

/** Unschema'd values present in a note set, deduped case-insensitively
    (first casing wins) and sorted for display — the shared "extras" tail of
    board columns and table sections. List-valued props contribute each item,
    matching the per-item bucketing. A number-kind prop
    dedupes by numeric value instead — `1200` and `1200.00` yield ONE extra,
    spelled as first seen, the same fold `bucketByProp` drains by. */
export function extraValues(
  notes: NoteMeta[],
  groupBy: string,
  options: SelectOption[],
  typeSchema?: Record<string, PropSchema>
): string[] {
  const keyOf = groupKeyer(isNumberKey(groupBy, typeSchema));
  const schemaKeys = new Set(options.map((o) => keyOf(o.value)));
  const extras = new Map<string, string>(); // group key → display spelling
  for (const n of notes) {
    for (const v of propGroupValues(n.props, groupBy)) {
      const k = keyOf(v);
      if (!schemaKeys.has(k) && !extras.has(k)) extras.set(k, v);
    }
  }
  return [...extras.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** The notes behind a grouped view, each counted once. Per-item
    grouping deliberately places a list-valued note in several sections, so
    the flat row sequence holds it once per membership — right for display and
    focus, wrong for anything that answers "how many notes, and what do their
    values add up to". Order follows first appearance, so a de-duplicated set
    still reads in view order. */
export function distinctNotes(notes: NoteMeta[]): NoteMeta[] {
  const seen = new Set<string>();
  const out: NoteMeta[] = [];
  for (const n of notes) {
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    out.push(n);
  }
  return out;
}

/** Apply a board's hand order to one column's notes. Mirrors
    `orderedColumns`: the notes the order names lead, in its sequence; every
    other note keeps the order it came in (the view's resting order) behind
    them. Paths naming no note here are skipped, so an order carrying notes
    from other columns — the field is one flat list for the whole board —
    arranges each column without knowing about the split, and a note deleted
    or renamed outside the app costs nothing but its own entry. */
export function orderedNotes(notes: NoteMeta[], order: string[] | undefined): NoteMeta[] {
  if (!order || order.length === 0) return notes;
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const lead: NoteMeta[] = [];
  const taken = new Set<string>();
  for (const path of order) {
    const n = byPath.get(path);
    if (n && !taken.has(path)) {
      lead.push(n);
      taken.add(path);
    }
  }
  if (lead.length === 0) return notes;
  return [...lead, ...notes.filter((n) => !taken.has(n.path))];
}

/** The key a section is remembered by between renders — a folded collapse
    set and a hand-dragged section order both name sections by VALUE, and the
    valueless "No <prop>" section by the empty string, which no real group
    value can take (`propGroupValues` drops empties). Folded by casing the
    way `bucketByProp` folds, so two spellings sharing a section share its
    memory too. A number column's sections fold by numeric value on screen
    but are remembered by their spelling — `1200` collapsed and later
    respelled `1200.00` re-opens, which is the cheaper wrong of the two. */
export const NO_GROUP_KEY = "";

export function groupKey(value: string | null): string {
  return value === null ? NO_GROUP_KEY : value.toLowerCase();
}

/** Apply a table's hand order to its sections. Mirrors `orderedNotes`: the
    sections the order names lead, in its sequence; every other section keeps
    the order grouping produced (schema options, extras, then "No …") behind
    them. Keys naming no section here are skipped, so a section that emptied
    out — or a schema option renamed outside the app — costs nothing but its
    own entry, and a group appearing later joins in its default place. */
export function orderedGroups(groups: NoteGroup[], order: string[] | undefined): NoteGroup[] {
  if (!order || order.length === 0) return groups;
  const byKey = new Map(groups.map((g) => [groupKey(g.value), g]));
  const lead: NoteGroup[] = [];
  const taken = new Set<string>();
  for (const value of order) {
    const k = groupKey(value);
    const g = byKey.get(k);
    if (g && !taken.has(k)) {
      lead.push(g);
      taken.add(k);
    }
  }
  if (lead.length === 0) return groups;
  return [...lead, ...groups.filter((g) => !taken.has(groupKey(g.value)))];
}

/** The prop a table groups by: the saved pref when it still names
    a groupable column (multi-kind excluded; rollup excluded
    too — a derived column groups nothing), else ungrouped — unlike
    the board, a table has no fallback grouping. */
export function tableGroupBy(
  columns: string[],
  typeSchema: Record<string, PropSchema>,
  pref?: string
): string | undefined {
  if (!pref) return undefined;
  const groupable = columns.filter(
    (c) => {
      const kind = byFoldedKey(typeSchema, c)?.kind;
      return kind !== "multi" && kind !== "rollup";
    }
  );
  return canonicalColumn(groupable, pref);
}

/** Table grouping: one section per schema option that holds visible
    notes, in option order; unschema'd values follow (alphabetical); the
    "No …" section trails. Empty sections are dropped — a table partition
    shows only what's there (the board's empty drop-target columns are a
    board-only concern). Rows keep their incoming order inside a section —
    the view's sort applies per section, unchanged. */
export function tableGroups(
  visible: NoteMeta[],
  groupBy: string,
  options: SelectOption[],
  typeSchema?: Record<string, PropSchema>
): NoteGroup[] {
  const { none, take } = bucketByProp(visible, groupBy, typeSchema);
  const groups: NoteGroup[] = [];
  for (const o of options) {
    const ns = take(o.value);
    if (ns.length > 0) groups.push({ value: o.value, notes: ns });
  }
  for (const v of extraValues(visible, groupBy, options, typeSchema)) {
    const ns = take(v);
    if (ns.length > 0) groups.push({ value: v, notes: ns });
  }
  if (none.length > 0) groups.push({ value: null, notes: none });
  return groups;
}
