/**
 * Accent folding in the search index's own language.
 *
 * The FTS table is built with `remove_diacritics 2`, so the engine already
 * matched "cafe" against "café" before any of this ran. Anything that marks or
 * re-matches search text on the frontend has to read it the same way, or a hit
 * the engine found renders plain — the mark is missing, not wrong, and the two
 * search doors disagree about the same note.
 */

/** "café" → "cafe"; combining marks drop, everything else is left alone. */
export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Fold `s` and keep the way back: `map[i]` is the index in `s` of the folded
 * character at `i`, and `map[folded.length]` is `s.length`. A match found on
 * the folded string slices the ORIGINAL through the map, so "café" is marked
 * whole — accent included — and the un-marked runs still concatenate back to
 * exactly the text that was passed in.
 */
export function foldWithMap(s: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const f = foldDiacritics(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(s.length);
  return { folded, map };
}
