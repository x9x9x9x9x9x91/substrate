/* Wikilink completion (SUB-269): the pure half of the [[ popup — query
   detection, title ranking, insert text — kept free of CodeMirror so it runs
   under node --test. Editor.tsx wraps these in a CompletionSource. */

import { fuzzyScore } from "./fuzzy.ts";

/** Cursor inside an open wikilink: `[[` + anything but a bracket or newline. */
const WIKI_OPEN_RE = /\[\[([^\]\n]*)$/;

/** The typed fragment when `textBefore` (doc text up to the cursor) ends
    inside an open `[[…` wikilink, else null. Mirrors the editor's
    matchBefore so ranking stays testable without an EditorState. */
export function wikiLinkQuery(textBefore: string): string | null {
  const m = WIKI_OPEN_RE.exec(textBefore);
  return m ? m[1] : null;
}

export interface WikiOption {
  title: string;
  score: number;
}

/** keep the popup snappy on large vaults — the fuzzy tail past this is noise */
const MAX_OPTIONS = 100;

/** Titles ranked for the [[ popup: fuzzy score descending, alphabetical
    tiebreak; misses and duplicate titles dropped. An empty query lists
    every title A→Z (fuzzyScore("") is a flat 1, the tiebreak sorts). */
export function wikiLinkOptions(query: string, titles: string[]): WikiOption[] {
  const seen = new Set<string>();
  const out: WikiOption[] = [];
  for (const raw of titles) {
    const title = raw.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const score = fuzzyScore(query, title);
    if (score < 0) continue;
    out.push({ title, score });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out.slice(0, MAX_OPTIONS);
}

/** Insert text for an accepted completion: close the link unless `]]`
    already follows the cursor (don't double-close). */
export function wikiLinkInsert(title: string, following: string): string {
  return following.startsWith("]]") ? title : `${title}]]`;
}
