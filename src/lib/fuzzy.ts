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
  for (const ch of q) {
    let found = -1;
    while (ti < tArr.length) {
      if (tArr[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return -1;
    streak = found > 0 && q.includes(tArr[found - 1]) ? streak + 1 : 0;
    score += 10 + streak * 5 - found * 0.2;
    ti = found + 1;
  }
  return score;
}
