/**
 * Palette command ranking (SUB-171).
 *
 * fuzzyScore bands: a prefix match scores 1000 - len, a word-start substring
 * scores just under 700, anything fuzzier lands lower. Destination rows
 * ("Go to X", "Dashboard: X", folders, nav) carry a bare `dest` name so the
 * query "release" prefix-matches "Release" even though the row label is
 * "Go to Release". Destinations in the exact/prefix band (>= HOIST_MIN) are
 * hoisted above the Content section — the destination beats body snippets,
 * Notion/Linear-style. Notes keep the very top: an exact note-title match is
 * never buried by a destination.
 */
import { fuzzyScore } from "./fuzzy.ts";

/** exact/prefix band: prefix matches score 1000 - len (>= 700 for sane names) */
export const HOIST_MIN = 700;

export interface Rankable {
  id: string;
  label: string;
  /** bare destination name ("Release" for "Go to Release") — destinations only */
  dest?: string;
}

/** best fuzzy score for a row: full label, or its destination name if it has one */
export function rankScore(q: string, item: Rankable): number {
  const label = fuzzyScore(q, item.label);
  return item.dest ? Math.max(label, fuzzyScore(q, item.dest)) : label;
}

/**
 * Order palette commands for a query: best score first, declaration order
 * breaks ties. An empty query keeps declaration order untouched. `hoisted`
 * is the subset of destination rows in the exact/prefix band, same order as
 * in `ranked` — callers render those above content hits.
 */
export function rankCommands<T extends Rankable>(
  q: string,
  commands: T[],
): { ranked: T[]; hoisted: T[] } {
  const query = q.trim();
  if (!query) return { ranked: commands, hoisted: [] };
  const ranked = commands
    .map((c, i) => ({ c, i, s: rankScore(query, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
  return {
    ranked,
    hoisted: ranked.filter((c) => !!c.dest && rankScore(query, c) >= HOIST_MIN),
  };
}

/**
 * True when a non-empty result list holds nothing but fallback rows — the
 * "New note “x”" / "New sheet “x”" / "See all results…" rows that render
 * whatever the query is. Callers use it to show a "No results" status.
 *
 * Tested against `fallback`, never an id whitelist: the query-echoing rows
 * embed the query verbatim in their label, so they always survive ranking,
 * and a whitelist silently goes stale the moment another one is added
 * (SUB-673 — "New sheet" broke the SUB-262 guard exactly that way).
 */
export function onlyFallbacks<T extends { fallback?: boolean }>(items: T[]): boolean {
  return items.length > 0 && items.every((i) => i.fallback === true);
}

/**
 * Re-insert hoisted rows directly under the Notes section — above Content and
 * Search — so an exact destination is visible without scrolling. Falls back
 * to the top when no Notes/Content/Search rows exist. Rows not in `hoisted`
 * keep their relative order.
 */
export function hoistAboveContent<T extends { id: string; section: string }>(
  items: T[],
  hoisted: T[],
): T[] {
  if (hoisted.length === 0) return items;
  const ids = new Set(hoisted.map((c) => c.id));
  const rest = items.filter((i) => !ids.has(i.id));
  const lastNote = rest.reduce((acc, it, idx) => (it.section === "Notes" ? idx : acc), -1);
  let at = lastNote + 1;
  if (lastNote === -1) {
    const below = rest.findIndex((it) => it.section === "Content" || it.section === "Search");
    at = below === -1 ? 0 : below;
  }
  rest.splice(at, 0, ...hoisted);
  return rest;
}
