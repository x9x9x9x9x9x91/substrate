import type { NoteMeta } from "./types.ts";
import { foldedTypeName } from "./types.ts";

/** Order the databases for a filing picker: most recently touched first.
    Filing a note is a "where does this belong" decision, and the answer is
    almost always a database you were just in — count-desc puts the vault's
    biggest archive on top instead, which is the one you file into least.
    Types with no notes sort last; anything tied keeps the incoming order
    (already count-desc), so the fallback is the old ranking, not chance. */
export function dbTypesByRecency(notes: NoteMeta[], dbTypes: string[]): string[] {
  const latest = new Map<string, number>();
  for (const n of notes) {
    const t = foldedTypeName(n.props);
    if (!t) continue;
    const prev = latest.get(t);
    if (prev === undefined || n.updated_ms > prev) latest.set(t, n.updated_ms);
  }
  return dbTypes
    .map((type, index) => ({ type, index, ms: latest.get(type.trim().toLowerCase()) }))
    .sort((a, b) => {
      if (a.ms === undefined || b.ms === undefined) {
        if (a.ms !== b.ms) return a.ms === undefined ? 1 : -1;
      } else if (a.ms !== b.ms) return b.ms - a.ms;
      return a.index - b.index || a.type.localeCompare(b.type);
    })
    .map((e) => e.type);
}
