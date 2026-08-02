import type { NoteMeta, RelatedEntry } from "./types.ts";
import { foldedPropStr, propStr } from "./types.ts";
import { fuzzyScore } from "./fuzzy.ts";

/** One entry of a relation's target database, as listed in the picker. */
export interface RelationCandidate {
  title: string;
  path: string;
}

/** A prop's value as a list: relation props store one target as a scalar,
    several as a YAML list; both read back as a plain string list. */
export function propList(props: Record<string, unknown>, key: string): string[] {
  const v = props[key];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  const s = propStr(props, key);
  return s ? [s] : [];
}

/** Stored form for a relation's values: scalar for one, list for several,
    null (prop removed) for none — keeps frontmatter minimal and stable. */
export function propListValue(values: string[]): string | string[] | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return values;
}

/** What the plain (untyped) chip editor should store for `key`.

    The chip's visible text comes from `propStr`, which joins a stored list
    into "Vinyl, Digital" for display. Committing that text straight back
    used to write it as one scalar string, silently collapsing the note's
    YAML list on a write that reported success. A prop that is stored as a
    list stays a list: the drafted text is split on commas and re-stored
    through `propListValue`'s shape rules (one value → scalar). Scalar props
    are untouched — commas in them are just text. */
export function chipCommitValue(current: unknown, text: string): string | string[] {
  if (!Array.isArray(current)) return text;
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // separator-only text isn't "remove" here — the caller's empty check owns
  // that; keep the literal draft rather than inventing a clear
  if (parts.length === 0) return text;
  return parts.length === 1 ? parts[0] : parts;
}

/** Multi-select toggle, case-insensitive so "Gero" and "gero" can't both stick. */
export function toggleValue(values: string[], v: string): string[] {
  const lower = v.toLowerCase();
  return values.some((x) => x.toLowerCase() === lower)
    ? values.filter((x) => x.toLowerCase() !== lower)
    : [...values, v];
}

/** Entries of the relation's target database, title-sorted. Duplicate titles
    collapse — the stored value is the title, so the first note wins. */
export function relationCandidates(notes: NoteMeta[], targetType: string): RelationCandidate[] {
  const seen = new Set<string>();
  const out: RelationCandidate[] = [];
  const foldedType = targetType.toLowerCase();
  const sorted = notes
    .filter((n) => foldedPropStr(n.props, "type")?.toLowerCase() === foldedType)
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const n of sorted) {
    const key = n.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: n.title, path: n.path });
  }
  return out;
}

/** Fuzzy-filter picker candidates, best score first; an empty query keeps
    the original (title) order. */
export function filterCandidates(
  candidates: RelationCandidate[],
  query: string
): RelationCandidate[] {
  const q = query.trim();
  if (!q) return candidates;
  return candidates
    .map((c) => ({ c, score: fuzzyScore(q, c.title) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title))
    .map((x) => x.c);
}

/** One group of the related-entries section: all notes of one database
    pointing at the open note ("3 releases point here"). */
export interface RelatedGroup {
  dbType: string;
  entries: RelatedEntry[];
}

/** Group related entries by source database, largest group first. */
export function relatedGroups(entries: RelatedEntry[]): RelatedGroup[] {
  const byType = new Map<string, RelatedGroup>();
  for (const e of entries) {
    const identity = e.db_type.toLowerCase();
    const group = byType.get(identity);
    if (group) group.entries.push(e);
    else byType.set(identity, { dbType: e.db_type, entries: [e] });
  }
  return [...byType.values()]
    .sort((a, b) => b.entries.length - a.entries.length || a.dbType.localeCompare(b.dbType));
}
