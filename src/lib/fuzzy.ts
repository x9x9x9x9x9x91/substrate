/**
 * The no-match sentinel. `fuzzyScore` returns exactly this, and only this, when
 * the query cannot be threaded through the target. A real match can still score
 * NEGATIVE — the subsequence branch charges 0.2 per character of position, so a
 * genuine hit late in a long label sums below zero — so callers must drop
 * candidates on this sentinel alone, never on `< 0` or `<= 0` (the
 * palette filtered on `> 0` and real matches silently vanished from results).
 */
export const NO_MATCH = -1;

/**
 * Real matches are floored just above the sentinel, so a deep match can never
 * land on it by float coincidence and read as a miss. Scores in this tail sort
 * last either way, so the ties the floor introduces are invisible.
 */
const MIN_MATCH = -0.5;

/** One matched span of the target, as UTF-16 indices ready for slicing. */
export interface MatchRun {
  start: number;
  end: number;
}

/**
 * WHERE the query threads through the target — the ranges `fuzzyScore`'s
 * branches match, so the palette can mark them. Null when the query does not
 * match (or is empty — nothing to mark). Mirrors the scoring branches:
 * a substring hit is one run; a subsequence hit is the greedy first-occurrence
 * scan, adjacent characters merged into runs. The substring branch indexes the
 * lowercased strings and slices the original — the same idiom as the search
 * pane's highlighter; the subsequence branch walks the original per code point
 * so surrogate pairs (emoji) keep their indices exact.
 */
export function fuzzyMatchRuns(query: string, target: string): MatchRun[] | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const t = target.toLowerCase();
  // the substring fast path indexes the LOWERED strings and slices the
  // original — only sound while lowercasing is length-preserving (İ isn't:
  // it lowers to two units and every later index skews). Rare enough to
  // just fall through to the per-char walk, which never mixes coordinates.
  if (t.length === target.length && q.length === query.length) {
    const idx = t.indexOf(q);
    if (idx >= 0) return [{ start: idx, end: idx + q.length }];
  }
  const qArr = Array.from(q);
  let qi = 0;
  const runs: MatchRun[] = [];
  let u = 0;
  for (const ch of Array.from(target)) {
    if (qi < qArr.length && ch.toLowerCase() === qArr[qi]) {
      const end = u + ch.length;
      const last = runs[runs.length - 1];
      if (last && last.end === u) last.end = end;
      else runs.push({ start: u, end });
      qi++;
    }
    u += ch.length;
  }
  return qi === qArr.length ? runs : null;
}

export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;
  if (idx > 0) {
    const wordStart = idx === 0 || t[idx - 1] === " " || t[idx - 1] === "-";
    return (wordStart ? 700 : 500) - idx - t.length * 0.1;
  }
  // scan the target by code points too — UTF-16 unit indexing never matches
  // surrogate-pair chars (emoji) against the query's code-point iteration
  const tArr = Array.from(t);
  let ti = 0;
  let score = 0;
  let streak = 0;
  // index of the previous matched char, -1 before the first match — the streak
  // bonus rewards a CONTIGUOUS run, so it needs the previous match position.
  // Asking whether the target char before this one appears anywhere in the
  // query hands the bonus to matches that are pages apart whenever a
  // query letter repeats in the target.
  let prev = -1;
  for (const ch of q) {
    let found = -1;
    while (ti < tArr.length) {
      if (tArr[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return NO_MATCH;
    streak = prev >= 0 && found === prev + 1 ? streak + 1 : 0;
    score += 10 + streak * 5 - found * 0.2;
    prev = found;
    ti = found + 1;
  }
  return Math.max(score, MIN_MATCH);
}
