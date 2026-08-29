/* How a list of notes is ordered — the Scratch list, the Notes list, and
   every folder list, which are one surface wearing three names.

   This is a preference, not an arrangement: "show me what I touched last"
   and "show me this folder alphabetically" are answers about the notes, so
   they live in `Settings.md` under `note-sort` and follow the vault to
   another machine. What a pane's scroll position is, or how wide it is,
   does not — see docs/vision.md goal 6.

   Every order here ends in the path tiebreak. A vault restored from a clone
   has near-identical mtimes across the whole tree, and a folder of dailies
   has repeated titles; without the last key those lists reshuffle between
   two renders of the same unchanged notes. The tiebreak is the same one
   `Engine::list` and `compareNotes` use, so a list the client patched and a
   list it re-fetched agree. */

import { parseDateLoose } from "./dates.ts";
import { displayTitle, journalOrder } from "./journal.ts";
import { foldedPropStr, type NoteMeta } from "./types.ts";

/** What a list is ordered by. `updated` is the file's mtime, `created` the
    note's own `created:` frontmatter, `name` the title a row displays. */
export type ListSortField = "updated" | "created" | "name";

export type ListSortDir = "desc" | "asc";

export interface ListSort {
  field: ListSortField;
  dir: ListSortDir;
}

/** Last edited, newest first — the Apple Notes model the Scratch list has
    always had, now the answer for every list that had no answer. */
export const DEFAULT_LIST_SORT: ListSort = { field: "updated", dir: "desc" };

const FIELDS: ListSortField[] = ["updated", "created", "name"];

/** The label a row of the sort control wears, and the word the note stores. */
export const FIELD_LABELS: Record<ListSortField, string> = {
  updated: "Last edited",
  created: "Created",
  name: "Name",
};

/** Which way round each field reads to a person: dates count down from now,
    names count up from A. The control says "Newest first", not "Descending". */
export const DIR_LABELS: Record<ListSortField, Record<ListSortDir, string>> = {
  updated: { desc: "Newest first", asc: "Oldest first" },
  created: { desc: "Newest first", asc: "Oldest first" },
  name: { asc: "A–Z", desc: "Z–A" },
};

/** The direction a field opens on when it is picked fresh — dates newest,
    names alphabetical. Flipping is then one more click. */
export function naturalDir(field: ListSortField): ListSortDir {
  return field === "name" ? "asc" : "desc";
}

/** The Journal's own dateline order, said in the control's vocabulary: a
    folder of dailies runs by the day each entry is FOR, newest first, which
    is what "Created — Newest first" means to a reader. The control shows this
    while nothing has been stated, rather than claiming the last-edited order
    the rows are visibly not in. */
export const JOURNAL_DATELINE_SORT: ListSort = { field: "created", dir: "desc" };

/** What the Journal yields — one pair with `journalShownSort` below, so the
    rows and the header can never disagree.

    Absence is the question, not the value: an explicitly stated
    `note-sort: updated desc` is a choice this vault made and outranks the
    dateline, exactly as every other explicit pick does. Comparing values
    instead would read that choice as "never chosen" and leave the Journal
    dateline-ordered under a header claiming otherwise. */
export function journalListOrder(notes: NoteMeta[], sort: ListSort | null): NoteMeta[] {
  return sort ? sortNotes(notes, sort) : journalOrder(notes);
}

/** What the Journal's sort control says the Journal is in. */
export function journalShownSort(sort: ListSort | null): ListSort {
  return sort ?? JOURNAL_DATELINE_SORT;
}

/** The single word pair stored in `Settings.md`: `note-sort: name asc`. One
    key rather than two, so a hand edit can never leave a field without its
    direction. */
export function formatListSort(sort: ListSort): string {
  return `${sort.field} ${sort.dir}`;
}

/** Read `note-sort`. Junk in either half degrades to that half's default
    rather than to nothing, so `note-sort: name` is A–Z and a typo'd
    direction still sorts by the field asked for. */
export function readListSort(value: unknown): ListSort {
  if (typeof value !== "string") return DEFAULT_LIST_SORT;
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const field = FIELDS.find((f) => words.includes(f));
  if (!field) return DEFAULT_LIST_SORT;
  const dir: ListSortDir = words.includes("asc")
    ? "asc"
    : words.includes("desc")
      ? "desc"
      : naturalDir(field);
  return { field, dir };
}

/** The note's own creation date, as the ISO day it stores, or null when it
    has none. The engine writes `created:` on every note it makes; a file
    somebody dropped into the vault by hand may not have one, and there is no
    birth time in the index to fall back on — so "no answer" is a real
    third state, not a zero. */
export function createdDay(n: NoteMeta): string | null {
  const raw = foldedPropStr(n.props, "created");
  return raw ? parseDateLoose(raw) : null;
}

function byPath(a: NoteMeta, b: NoteMeta): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Order a list. Returns a new array; the input is left alone.

    Notes with no `created:` sort last in BOTH directions. A missing date is
    not an ancient one, and burying the undated notes at the bottom of
    "oldest first" would be an answer the vault never gave. */
export function sortNotes(notes: NoteMeta[], sort: ListSort): NoteMeta[] {
  const flip = sort.dir === "asc" ? -1 : 1;
  const out = notes.slice();
  out.sort((a, b) => {
    let cmp = 0;
    if (sort.field === "updated") {
      cmp = b.updated_ms - a.updated_ms;
    } else if (sort.field === "created") {
      const [x, y] = [createdDay(a), createdDay(b)];
      if (x === null || y === null) {
        // undated last, whichever way the dated ones are running
        if (x !== y) return x === null ? 1 : -1;
      } else {
        cmp = y.localeCompare(x);
      }
    } else {
      cmp = displayTitle(a).localeCompare(displayTitle(b), undefined, {
        sensitivity: "base",
        numeric: true,
      });
      // read A–Z at `asc`, so the flip below has something to turn over
      cmp = -cmp;
    }
    return cmp !== 0 ? cmp * flip : byPath(a, b);
  });
  return out;
}
