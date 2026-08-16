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
import { foldDiacritics, foldWithMap } from "./fold.ts";
import { NO_MATCH, fuzzyMatchRuns, fuzzyScore } from "./fuzzy.ts";
import type { SnippetPart, View } from "./types.ts";

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

/** Slice `text` into alternating plain/hit parts along match runs — the
    bridge from fuzzy match positions to the search pane's part language. */
export function partsFromRuns(
  text: string,
  runs: { start: number; end: number }[],
): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const r of runs) {
    if (r.start > at) parts.push({ text: text.slice(at, r.start), hit: false });
    parts.push({ text: text.slice(r.start, r.end), hit: true });
    at = r.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * Label parts for a ranked row: the first query variant that threads through
 * the label wins, so the synonym rewrite is what marks "New database…" for
 * "create database". Null = no variant threads through the VISIBLE label
 * (the row matched via its bare `dest` name, or a daily matched by its stem
 * face) — render plain rather than guess.
 */
export function markLabel(q: string, label: string): SnippetPart[] | null {
  const query = q.trim();
  if (!query) return null;
  for (const v of queryVariants(query)) {
    const runs = fuzzyMatchRuns(v, label);
    if (runs && runs.length) return partsFromRuns(label, runs);
  }
  return null;
}

/**
 * Snippet parts in the engine's own match language: every whitespace token
 * word-prefix-matches (fts_match_expr appends `*`), and FTS5 highlight()
 * wraps the whole matched token — so a query "mast" marks all of "masters",
 * exactly as the search pane shows it. Accents fold on both sides, because
 * `remove_diacritics 2` is what let "cafe" match "café" in the first place —
 * matching runs on the folded text and the marks are cut out of the original,
 * so the accented word is marked whole. Null when nothing in the snippet
 * matches (the hit was elsewhere in the body).
 */
export function markSnippet(searchText: string, snippet: string): SnippetPart[] | null {
  const terms = foldDiacritics(searchText.toLowerCase()).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${terms.map(esc).join("|")})[\\p{L}\\p{N}_]*`,
    "giu",
  );
  const { folded, map } = foldWithMap(snippet);
  const parts: SnippetPart[] = [];
  let last = 0;
  let hits = 0;
  for (const m of folded.matchAll(re)) {
    const at = map[m.index ?? 0];
    const end = map[(m.index ?? 0) + m[0].length];
    if (at > last) parts.push({ text: snippet.slice(last, at), hit: false });
    parts.push({ text: snippet.slice(at, end), hit: true });
    hits += 1;
    last = end;
  }
  if (!hits) return null;
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

/* ── the fixed-destination catalogue ─────────────────────────────────────── */

/** What this machine offers, for destinations that only exist on some of
    them. The palette hands one of these to `when`. */
export interface ViewCommandCtx {
  /** a local proxy answered the boot probe */
  proxyAvailable: boolean;
}

/**
 * One destination that is always the same place — a view with nothing to
 * parameterize. Data rather than JSX so the row set is readable without
 * rendering: the drift test below compares it against the `View` union, which
 * is what stops the catalogue from quietly losing a whole surface again
 * (Calendar, Vault sync and What's new each had a key or a glyph and no row).
 */
export interface ViewCommand {
  /** palette row id */
  id: string;
  /** the row's own words */
  label: string;
  /** bare destination name for ranking ("Today" for "Go to Today"); absent
      on rows that read as an operation rather than a place */
  dest?: string;
  view: View;
  /** shortcut registry id whose first combo labels the row — never a
      hand-typed keycap, which is how the redo row came to print a chord the
      sheet spelled the other way round */
  shortcut?: string;
  /** rows that only exist on some machines, gated exactly as their sidebar
      row is */
  when?: (ctx: ViewCommandCtx) => boolean;
}

/** Declaration order is the palette's browse order, and it breaks ranking
    ties — keep the everyday jumps on top. */
export const FIXED_VIEW_COMMANDS: ViewCommand[] = [
  { id: "cmd:today", label: "Go to Today", dest: "Today", view: { kind: "today" }, shortcut: "view-today" },
  { id: "cmd:notes", label: "Go to Notes", dest: "Notes", view: { kind: "notes" }, shortcut: "view-notes" },
  { id: "cmd:all", label: "Go to All notes", dest: "All notes", view: { kind: "all" }, shortcut: "view-all" },
  {
    id: "cmd:calendar",
    label: "Go to Calendar",
    dest: "Calendar",
    view: { kind: "calendar" },
    shortcut: "view-calendar",
  },
  {
    id: "cmd:dbmanager",
    label: "Go to All databases",
    dest: "All databases",
    view: { kind: "dbmanager" },
  },
  // The search pane, from a palette with nothing typed yet. "See all
  // results…" only appears once there IS a query, so an empty palette had no
  // route to search at all.
  { id: "cmd:search", label: "Search notes", dest: "Search", view: { kind: "search" }, shortcut: "search" },
  { id: "cmd:trash", label: "Open Trash", dest: "Trash", view: { kind: "trash" } },
  { id: "cmd:assets", label: "Clean up orphaned assets…", view: { kind: "assets" } },
  { id: "cmd:doctor", label: "Vault doctor", dest: "Vault doctor", view: { kind: "doctor" } },
  { id: "cmd:vaultsync", label: "Vault sync", dest: "Vault sync", view: { kind: "vaultsync" } },
  // the sidebar's sparkle glyph, in words — the glyph carries its name in a
  // tooltip only, so nothing about it is searchable
  { id: "cmd:changelog", label: "What's new", dest: "What's new", view: { kind: "changelog" } },
  {
    id: "cmd:cookbook",
    label: "Browse dashboard cookbook",
    dest: "Cookbook",
    view: { kind: "cookbook" },
  },
];

/** How the palette produces a parameterized destination.
    - `"row"`: the component names that view kind itself, one row per thing.
    - `"opener"`: it hands a database name to the app's opener, which decides
      between the database view and the mount view — so a mount is reachable
      without the palette knowing what a mount is. */
export type GeneratedBy = "row" | "opener";

/**
 * The view kinds that name a specific thing, each with the way the palette
 * generates it. Listed rather than inferred: the drift test demands every kind
 * in the `View` union be either a fixed row above or named here, so a new
 * parameterized surface has to say out loud how the palette reaches it — and
 * the VALUES are checked against the component source too, so an entry
 * claiming a row that no longer exists fails rather than reading as true.
 */
export const GENERATED_VIEW_KINDS: Record<string, GeneratedBy> = {
  db: "opener",
  mount: "opener",
  saved: "row",
  dashboard: "row",
  folder: "row",
  tagfolder: "row",
  tag: "row",
};

/** Registry ids the catalogue prints keycaps for — the drift test resolves
    each against the shortcut registry, so a renamed binding fails the suite
    instead of throwing in front of a user. */
export function paletteShortcutIds(): string[] {
  return FIXED_VIEW_COMMANDS.flatMap((c) => (c.shortcut ? [c.shortcut] : []));
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
