/** What to call the things a search counted. A vault of notes says "notes" —
    its own word for what it holds — and a count that can hold mounted files or
    pictures says "results" instead: calling a PDF or a screenshot a note in
    the one place the pane states a number is the kind of small lie that makes
    a count untrustworthy.

    `mixed` is a fact about the NUMBER, not about the page it is printed
    beside. A page of ten notes can sit under a total of three thousand rows
    of which most are files, so the two numbers on that line are not always
    labelled the same way, and shouldn't be. */
export function resultUnit(n: number, mixed: boolean): string {
  if (mixed) return n === 1 ? "result" : "results";
  return n === 1 ? "note" : "notes";
}

/** Everything the stats line above the results is computed from. */
export interface SearchStatsInput {
  /** a text query is running — false leaves only the operator count */
  searching: boolean;
  /** structured operators (`type:`, `folder:`, …) are in play */
  filtered: boolean;
  /** rows drawn on this page */
  groups: number;
  /** rows on this page that `total` actually counts — pictures ride a page of
      their own beside the notes and are not in the engine's note total, so
      without this a page of 200 notes plus 40 screenshots reads as "first 240
      of 210". Defaults to `groups`, which is right whenever the page and the
      total count the same kinds of row. */
  pagedNotes?: number;
  /** matches summed across this page */
  matches: number;
  /** the engine's count of every matching row, past the page cap */
  total: number;
  /** the engine had more than it sent */
  truncated: boolean;
  /** this page draws at least one row that is not a note — a mounted file, or
      a picture whose text was recognized */
  pageHasNonNoteRow: boolean;
  /** this vault has mounts at all — so the engine's total may count files
      that never reached the page, which is unknowable from the page itself */
  vaultHasMounts: boolean;
}

/** The line above the results, in three states: an operator-only filter
    counts what it kept; a page that ran out reports itself as a page rather
    than inventing a total the engine never sent; a whole page reports its
    matches. Empty string = nothing worth saying. */
export function searchStats(i: SearchStatsInput): string {
  const page = (n: number) => resultUnit(n, i.pageHasNonNoteRow);
  if (!i.searching) return i.filtered ? `${i.groups} ${page(i.groups)}` : "";
  if (i.truncated)
    return `first ${i.pagedNotes ?? i.groups} of ${i.total} ${resultUnit(i.total, i.pageHasNonNoteRow || i.vaultHasMounts)}`;
  return `${i.matches} ${i.matches === 1 ? "match" : "matches"} in ${i.groups} ${page(i.groups)}`;
}
