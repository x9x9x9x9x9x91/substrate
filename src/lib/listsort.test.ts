import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIST_SORT,
  JOURNAL_DATELINE_SORT,
  createdDay,
  formatListSort,
  journalListOrder,
  journalShownSort,
  naturalDir,
  readListSort,
  sortNotes,
  type ListSort,
} from "./listsort.ts";
import type { NoteMeta } from "./types.ts";

function note(path: string, updated_ms: number, props: Record<string, unknown> = {}): NoteMeta {
  const stem = path.split("/").pop()!.replace(/\.md$/, "");
  return {
    path,
    stem,
    title: (props.title as string) ?? stem,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    props,
    updated_ms,
    excerpt: "",
    sealed: false,
  };
}

const paths = (ns: NoteMeta[]) => ns.map((n) => n.path);

test("readListSort: the default when unasked, and each half degrades on its own", () => {
  assert.deepEqual(readListSort(undefined), DEFAULT_LIST_SORT);
  assert.deepEqual(readListSort(""), DEFAULT_LIST_SORT);
  assert.deepEqual(readListSort("   "), DEFAULT_LIST_SORT);
  assert.deepEqual(readListSort(null), DEFAULT_LIST_SORT);
  assert.deepEqual(readListSort(true), DEFAULT_LIST_SORT);
  assert.deepEqual(readListSort(7), DEFAULT_LIST_SORT);
  assert.deepEqual(readListSort(["name", "asc"]), DEFAULT_LIST_SORT);
  // a field nobody knows is not a field
  assert.deepEqual(readListSort("colour desc"), DEFAULT_LIST_SORT);

  assert.deepEqual(readListSort("updated desc"), { field: "updated", dir: "desc" });
  assert.deepEqual(readListSort("created asc"), { field: "created", dir: "asc" });
  assert.deepEqual(readListSort("name asc"), { field: "name", dir: "asc" });
  // hand-editable: spacing and case are the author's business
  assert.deepEqual(readListSort("  NAME   DESC  "), { field: "name", dir: "desc" });
  assert.deepEqual(readListSort("Created\tAsc"), { field: "created", dir: "asc" });
  // a field with no direction opens the way that field reads
  assert.deepEqual(readListSort("name"), { field: "name", dir: "asc" });
  assert.deepEqual(readListSort("created"), { field: "created", dir: "desc" });
  // ...and a typo'd direction still sorts by the field asked for
  assert.deepEqual(readListSort("name backwards"), { field: "name", dir: "asc" });
});

test("note-sort round-trips through the one string Settings.md stores", () => {
  const every: ListSort[] = [];
  for (const field of ["updated", "created", "name"] as const)
    for (const dir of ["desc", "asc"] as const) every.push({ field, dir });
  for (const sort of every) {
    assert.deepEqual(readListSort(formatListSort(sort)), sort, formatListSort(sort));
  }
  assert.equal(formatListSort(DEFAULT_LIST_SORT), "updated desc");
  assert.equal(naturalDir("name"), "asc");
  assert.equal(naturalDir("updated"), "desc");
});

test("last edited, newest first — and the same order every time it is asked", () => {
  const notes = [note("b.md", 300), note("a.md", 100), note("c.md", 200)];
  assert.deepEqual(paths(sortNotes(notes, { field: "updated", dir: "desc" })), [
    "b.md",
    "c.md",
    "a.md",
  ]);
  assert.deepEqual(paths(sortNotes(notes, { field: "updated", dir: "asc" })), [
    "a.md",
    "c.md",
    "b.md",
  ]);
  // the input is left alone — App re-sorts a memoised array it does not own
  assert.deepEqual(paths(notes), ["b.md", "a.md", "c.md"]);
});

test("a whole list of equal timestamps still has one settled order", () => {
  // a vault restored from a clone: every mtime is the checkout, so the
  // tiebreak IS the order. Without it the list reshuffles between renders.
  const same = 1_700_000_000_000;
  const notes = ["Notes/d.md", "a.md", "Notes/b.md", "c.md"].map((p) => note(p, same));
  const once = paths(sortNotes(notes, DEFAULT_LIST_SORT));
  assert.deepEqual(once, ["Notes/b.md", "Notes/d.md", "a.md", "c.md"]);
  // asked again, and asked of a differently-shuffled input, same answer
  assert.deepEqual(paths(sortNotes(notes, DEFAULT_LIST_SORT)), once);
  assert.deepEqual(paths(sortNotes(notes.slice().reverse(), DEFAULT_LIST_SORT)), once);
  // and the tiebreak does not flip with the direction — it is not a key,
  // it is the settlement
  assert.deepEqual(paths(sortNotes(notes, { field: "updated", dir: "asc" })), once);
});

test("name sorts by the title the row displays, A–Z at asc", () => {
  const notes = [
    note("z.md", 1, { title: "Apple" }),
    note("a.md", 2, { title: "banana" }),
    note("m.md", 3, { title: "Cherry" }),
  ];
  assert.deepEqual(paths(sortNotes(notes, { field: "name", dir: "asc" })), [
    "z.md",
    "a.md",
    "m.md",
  ]);
  assert.deepEqual(paths(sortNotes(notes, { field: "name", dir: "desc" })), [
    "m.md",
    "a.md",
    "z.md",
  ]);
});

test("name reads a Journal daily as the date the row shows, not its stem", () => {
  // the row paints "Jul 3, 2026"; sorting by the stem would order these by a
  // string the eye never sees
  const notes = [note("Journal/2026-07-03.md", 1), note("Journal/2026-07-01.md", 2)];
  const asc = paths(sortNotes(notes, { field: "name", dir: "asc" }));
  assert.equal(asc.length, 2);
  assert.deepEqual(paths(sortNotes(notes, { field: "name", dir: "desc" })), asc.slice().reverse());
});

test("created reads the note's own date, and undated notes sort last either way", () => {
  const notes = [
    note("mid.md", 10, { created: "2026-07-05" }),
    note("none.md", 99),
    note("new.md", 1, { created: "2026-08-01" }),
    note("old.md", 50, { created: "2026-01-09" }),
    note("junk.md", 2, { created: "not a date" }),
  ];
  assert.deepEqual(paths(sortNotes(notes, { field: "created", dir: "desc" })), [
    "new.md",
    "mid.md",
    "old.md",
    "junk.md",
    "none.md",
  ]);
  // a missing date is not an ancient one — the undated pair stays at the
  // bottom when the dated notes run the other way
  assert.deepEqual(paths(sortNotes(notes, { field: "created", dir: "asc" })), [
    "old.md",
    "mid.md",
    "new.md",
    "junk.md",
    "none.md",
  ]);
});

test("created is read case-folded and loosely, like every other prop", () => {
  assert.equal(createdDay(note("a.md", 1, { Created: "2026-07-17" })), "2026-07-17");
  assert.equal(createdDay(note("a.md", 1, { created: "Jul 17, 2026" })), "2026-07-17");
  assert.equal(createdDay(note("a.md", 1)), null);
  assert.equal(createdDay(note("a.md", 1, { created: "" })), null);
  assert.equal(createdDay(note("a.md", 1, { created: "zzz" })), null);
});

/* The Journal is the one folder with an order of its own. Which of the two
   orders it is in turns on whether the vault has STATED an answer, not on
   what that answer happens to be — and the header has to say the one the
   rows are actually in. */

const journalNotes = () => [
  note("Journal/2026-07-17.md", 900),
  note("Journal/2026-07-18.md", 100),
  note("Journal/ideas.md", 500),
];

test("the Journal keeps its dateline order while the vault has stated nothing", () => {
  assert.deepEqual(paths(journalListOrder(journalNotes(), null)), [
    "Journal/2026-07-18.md",
    "Journal/2026-07-17.md",
    "Journal/ideas.md",
  ]);
});

test("an explicitly stated order outranks the Journal's dateline, default value or not", () => {
  // the near-miss the value comparison got wrong: `updated desc` IS a choice
  assert.deepEqual(paths(journalListOrder(journalNotes(), { field: "updated", dir: "desc" })), [
    "Journal/2026-07-17.md",
    "Journal/ideas.md",
    "Journal/2026-07-18.md",
  ]);
  // by the title a row DISPLAYS: "Fri, 17 Jul 2026", "ideas", "Sat, 18 Jul 2026"
  assert.deepEqual(paths(journalListOrder(journalNotes(), { field: "name", dir: "asc" })), [
    "Journal/2026-07-17.md",
    "Journal/ideas.md",
    "Journal/2026-07-18.md",
  ]);
});

test("the Journal's control says the order the rows are in, both ways round", () => {
  // stating nothing: the dateline order, said in the control's own words
  assert.deepEqual(journalShownSort(null), JOURNAL_DATELINE_SORT);
  assert.notDeepEqual(journalShownSort(null), DEFAULT_LIST_SORT);
  // stating something: whatever was stated, including the default value
  for (const sort of [
    { field: "updated", dir: "desc" },
    { field: "name", dir: "asc" },
  ] as ListSort[])
    assert.deepEqual(journalShownSort(sort), sort);
});
