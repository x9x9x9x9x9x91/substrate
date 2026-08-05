/**
 * Palette command ranking.
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
import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";

/** exact/prefix band: prefix matches score 1000 - len (>= 700 for sane names) */
export const HOIST_MIN = 700;

/**
 * Verb aliases the palette understands: command labels say "New" /
 * "Trash" / "Settings", people type "create" / "delete" / "preferences".
 * Applied token-wise to build one rewritten query variant; scoring takes the
 * best of original and rewrite, so a literal match never loses to its alias.
 */
const SYNONYMS = new Map<string, string>([
  ["create", "new"],
  ["make", "new"],
  ["add", "new"],
  ["delete", "trash"],
  ["remove", "trash"],
  ["preferences", "settings"],
  ["prefs", "settings"],
  ["options", "settings"],
  ["goto", "go to"],
]);

/** articles dropped from the rewrite — "create a note" reads as "new note" */
const FILLER = new Set(["a", "an", "the"]);

/** the query plus its synonym rewrite, when the rewrite differs */
export function queryVariants(q: string): string[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rewritten = words
    .filter((w) => !FILLER.has(w))
    .map((w) => SYNONYMS.get(w) ?? w)
    .join(" ");
  return rewritten && rewritten !== words.join(" ") ? [q, rewritten] : [q];
}

/** fuzzyScore over the query and its synonym rewrite — best variant wins */
export function synFuzzyScore(q: string, target: string): number {
  let best: number = NO_MATCH;
  for (const v of queryVariants(q)) best = Math.max(best, fuzzyScore(v, target));
  return best;
}

export interface Rankable {
  id: string;
  label: string;
  /** bare destination name ("Release" for "Go to Release") — destinations only */
  dest?: string;
}

/** best fuzzy score for a row: full label, or its destination name if it has one */
export function rankScore(q: string, item: Rankable): number {
  const label = synFuzzyScore(q, item.label);
  return item.dest ? Math.max(label, synFuzzyScore(q, item.dest)) : label;
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
    // a row is dropped only when the query cannot be threaded through it at
    // all: a weak match ranks last, it does not disappear
    .filter((x) => x.s > NO_MATCH)
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
 * ("New sheet" broke the guard exactly that way).
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
