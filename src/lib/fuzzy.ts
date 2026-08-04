/**
 * The no-match sentinel. `fuzzyScore` returns exactly this, and only this, when
 * the query cannot be threaded through the target. A real match can still score
 * NEGATIVE — the subsequence branch charges 0.2 per character of position, so a
 * genuine hit late in a long label sums below zero — so callers must drop
 * candidates on this sentinel alone, never on `< 0` or `<= 0` (SUB-1016: the
 * palette filtered on `> 0` and real matches silently vanished from results).
 */
export const NO_MATCH = -1;

/**
 * Real matches are floored just above the sentinel, so a deep match can never
 * land on it by float coincidence and read as a miss. Scores in this tail sort
 * last either way, so the ties the floor introduces are invisible.
 */
const MIN_MATCH = -0.5;

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
  // query (SUB-1016) hands the bonus to matches that are pages apart whenever a
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
