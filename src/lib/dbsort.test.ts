import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SORT_KEYS, cycleSortKeys, restingCmp, sortCmpFor } from "./dbsort.ts";
import type { NoteMeta, PropSchema, SavedViewSort } from "./types.ts";

function note(title: string, props: Record<string, unknown>): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

function titles(cmp: (a: NoteMeta, b: NoteMeta) => number, ns: NoteMeta[]): string[] {
  return [...ns].sort(cmp).map((n) => n.title);
}

test("sortCmpFor: empty list sorts nothing", () => {
  assert.equal(sortCmpFor([]), null);
});

test("restingCmp: title order, numeric-aware, blind to recency (SUB-265)", () => {
  const fresh = note("Beta", {});
  fresh.updated_ms = 200;
  const stale = note("alpha", {});
  stale.updated_ms = 100;
  // vault_list order (updated_ms desc) would lead with Beta; the resting
  // order reads the title only, base-case insensitive like explicit sorts
  assert.deepEqual(titles(restingCmp, [fresh, stale]), ["alpha", "Beta"]);
  assert.deepEqual(titles(restingCmp, [note("SMP-10", {}), note("SMP-2", {})]), ["SMP-2", "SMP-10"]);
});

test("sortCmpFor: one key keeps the legacy single-sort semantics", () => {
  const cmp = sortCmpFor([{ key: "status", dir: 1 }])!;
  const live = note("b-live", { status: "live" });
  const parked = note("a-parked", { status: "parked" });
  const none = note("z-none", {});
  assert.deepEqual(titles(cmp, [parked, none, live]), ["b-live", "a-parked", "z-none"]);
  // desc flips valued rows, but missing values still trail
  const desc = sortCmpFor([{ key: "status", dir: -1 }])!;
  assert.deepEqual(titles(desc, [live, none, parked]), ["a-parked", "b-live", "z-none"]);
  // title is a first-class key, numeric-aware
  const byTitle = sortCmpFor([{ key: "title", dir: 1 }])!;
  assert.deepEqual(titles(byTitle, [note("SMP-10", {}), note("SMP-2", {})]), ["SMP-2", "SMP-10"]);
});

test("sortCmpFor reads a canonical column across note key casing (SUB-728)", () => {
  const cmp = sortCmpFor([{ key: "Status", dir: 1 }], { status: { options: [] } })!;
  assert.deepEqual(
    titles(cmp, [note("done", { status: "done" }), note("todo", { STATUS: "todo" })]),
    ["done", "todo"]
  );
});

test("sortCmpFor: a date key sorts chronologically across both separators (SUB-571)", () => {
  const schema: Record<string, PropSchema> = { due: { options: [], kind: "date" } };
  const cmp = sortCmpFor([{ key: "due", dir: 1 }], schema)!;
  // "T" collates after " ", so the earlier T-form used to fall below a later
  // space-form on the same day — same instant, two spellings
  assert.deepEqual(
    titles(cmp, [
      note("afternoon", { due: "2026-08-01 14:30" }),
      note("morning", { due: "2026-08-01T09:30" }),
    ]),
    ["morning", "afternoon"]
  );
  // day-only sorts before any timed value on the same day, and days order
  assert.deepEqual(
    titles(cmp, [
      note("later-day", { due: "2026-08-02T08:00" }),
      note("timed", { due: "2026-08-01 23:59" }),
      note("allday", { due: "2026-08-01" }),
    ]),
    ["allday", "timed", "later-day"]
  );
  // desc is the same order reversed
  const desc = sortCmpFor([{ key: "due", dir: -1 }], schema)!;
  assert.deepEqual(
    titles(desc, [
      note("afternoon", { due: "2026-08-01 14:30" }),
      note("morning", { due: "2026-08-01T09:30" }),
    ]),
    ["afternoon", "morning"]
  );
  // a cell that isn't date-shaped still collates, never throws
  assert.deepEqual(
    titles(cmp, [note("junk", { due: "soonish" }), note("real", { due: "2026-08-01" })]),
    ["real", "junk"]
  );
});

test("sortCmpFor: a date key keeps undated cells last in both directions", () => {
  const schema: Record<string, PropSchema> = { due: { options: [], kind: "date" } };
  const rows = () => [
    note("junk", { due: "soonish" }),
    note("early", { due: "2026-08-01" }),
    note("blank", {}),
    note("late", { due: "2026-09-01" }),
    note("alsojunk", { due: "TBD" }),
  ];
  const asc = sortCmpFor([{ key: "due", dir: 1 }], schema)!;
  assert.deepEqual(titles(asc, rows()), ["early", "late", "junk", "alsojunk", "blank"]);
  // "newest first" must not lead with cells that hold no date: dir flips the
  // order WITHIN the dated class, never the classification itself
  const desc = sortCmpFor([{ key: "due", dir: -1 }], schema)!;
  assert.deepEqual(titles(desc, rows()), ["late", "early", "alsojunk", "junk", "blank"]);
});

test("sortCmpFor: a date range sorts by its start, never its end (SUB-596)", () => {
  const schema: Record<string, PropSchema> = { due: { options: [], kind: "date" } };
  const cmp = sortCmpFor([{ key: "due", dir: 1 }], schema)!;
  // the long span opens first, so it leads despite closing last
  assert.deepEqual(
    titles(cmp, [
      note("short-later", { due: "2026-09-05/2026-09-06" }),
      note("long-early", { due: "2026-09-01/2026-09-30" }),
    ]),
    ["long-early", "short-later"]
  );
  // a span and a single date on the same day sit together, all-day first
  assert.deepEqual(
    titles(cmp, [
      note("span-timed", { due: "2026-09-01 09:00/2026-09-03 17:00" }),
      note("single", { due: "2026-09-01" }),
      note("next-day", { due: "2026-09-02" }),
    ]),
    ["single", "span-timed", "next-day"]
  );
});

test("sortCmpFor: a number key sorts by value, not by digit-run collation", () => {
  const schema: Record<string, PropSchema> = { balance: { options: [], kind: "number" } };
  const cmp = sortCmpFor([{ key: "balance", dir: 1 }], schema)!;
  // the collator compares each RUN of digits as an integer, so ".5" vs ".45"
  // reads as 5 vs 45 — place value is lost and 1299.5 lands before 1299.45.
  assert.deepEqual(
    titles(cmp, [
      note("half", { balance: "1299.5" }),
      note("less", { balance: "1299.45" }),
      note("more", { balance: "1299.7" }),
    ]),
    ["less", "half", "more"]
  );
  // "-" reads as punctuation, never a sign: negatives came out by magnitude
  assert.deepEqual(
    titles(cmp, [
      note("five", { balance: "-5" }),
      note("grand", { balance: "-1000" }),
      note("mid", { balance: "-486.2" }),
    ]),
    ["grand", "mid", "five"]
  );
  // desc is the exact reverse of the valued order
  const desc = sortCmpFor([{ key: "balance", dir: -1 }], schema)!;
  assert.deepEqual(
    titles(desc, [note("a", { balance: "9.9" }), note("b", { balance: "10" })]),
    ["b", "a"]
  );
  // a non-numeric cell in a number column (the shipped ledger fixture has a
  // literal "see csv" gross) can't be ordered against numbers — it trails
  // them, ahead of only genuinely missing values, and collates with its own
  assert.deepEqual(
    titles(cmp, [
      note("text", { balance: "see csv" }),
      note("num", { balance: "-3" }),
      note("blank", {}),
      note("alsotext", { balance: "n/a" }),
    ]),
    ["num", "alsotext", "text", "blank"]
  );
  // DESC keeps unorderable cells BEHIND the numbers — "largest first" must
  // not lead with junk; the classification is direction-independent, like the
  // missing-values rule (only the within-kind comparisons flip)
  assert.deepEqual(
    titles(desc, [
      note("text", { balance: "see csv" }),
      note("num", { balance: "100" }),
      note("neg", { balance: "-3" }),
      note("blank", {}),
      note("alsotext", { balance: "n/a" }),
    ]),
    ["num", "neg", "text", "alsotext", "blank"]
  );
  // integers still behave, and unschema'd keys keep the old collation
  const noSchema = sortCmpFor([{ key: "balance", dir: 1 }])!;
  assert.deepEqual(
    titles(noSchema, [note("ten", { balance: "SMP-10" }), note("two", { balance: "SMP-2" })]),
    ["two", "ten"]
  );
});

test("sortCmpFor: ties on the primary key fall through to the secondary", () => {
  const cmp = sortCmpFor([
    { key: "status", dir: 1 },
    { key: "title", dir: 1 },
  ])!;
  const a = note("Zephyr", { status: "live" });
  const b = note("Amber", { status: "live" });
  const c = note("Meadow", { status: "parked" });
  assert.deepEqual(titles(cmp, [a, b, c]), ["Amber", "Zephyr", "Meadow"]);
});

test("sortCmpFor: dir mixing — asc primary, desc secondary", () => {
  const cmp = sortCmpFor([
    { key: "status", dir: 1 },
    { key: "title", dir: -1 },
  ])!;
  const a = note("Amber", { status: "live" });
  const b = note("Zephyr", { status: "live" });
  const c = note("Meadow", { status: "parked" });
  assert.deepEqual(titles(cmp, [a, b, c]), ["Zephyr", "Amber", "Meadow"]);
});

test("sortCmpFor: the missing-values rule applies per key", () => {
  const cmp = sortCmpFor([
    { key: "status", dir: 1 },
    { key: "title", dir: 1 },
  ])!;
  const valued = note("Zephyr", { status: "live" });
  const noneB = note("Beta", {});
  const noneA = note("Alpha", {});
  // a row missing the PRIMARY trails every valued row, however its title compares
  assert.deepEqual(titles(cmp, [noneA, valued, noneB]), ["Zephyr", "Alpha", "Beta"]);
  // both missing the primary: the secondary key decides between them
  assert.ok(noneA.title < noneB.title, "test ordered by secondary title");
  // missing on the SECONDARY: ties on the primary, the row with a value wins
  const cmp2 = sortCmpFor([
    { key: "status", dir: -1 },
    { key: "artist", dir: -1 },
  ])!;
  const withArtist = note("a", { status: "live", artist: "moss" });
  const noArtist = note("b", { status: "live" });
  assert.deepEqual(titles(cmp2, [noArtist, withArtist]), ["a", "b"]);
});

test("sortCmpFor: a select key sorts by schema option order, not A→Z (SUB-309)", () => {
  const schema: Record<string, PropSchema> = {
    priority: { options: [{ value: "High" }, { value: "Medium" }, { value: "Low" }] },
  };
  const high = note("a-high", { priority: "High" });
  const med = note("b-med", { priority: "Medium" });
  const low = note("c-low", { priority: "Low" });
  // lexicographic would give High → Low → Medium; option order is the triage order
  const asc = sortCmpFor([{ key: "priority", dir: 1 }], schema)!;
  assert.deepEqual(titles(asc, [low, med, high]), ["a-high", "b-med", "c-low"]);
  // the option match ignores casing — a hand-typed "medium" sits at its option's slot
  const medLower = note("b2-med", { priority: "medium" });
  assert.deepEqual(titles(asc, [low, medLower, high]), ["a-high", "b2-med", "c-low"]);
  // desc reverses the option order — every row here is a known option, so the
  // whole column flips
  const desc = sortCmpFor([{ key: "priority", dir: -1 }], schema)!;
  assert.deepEqual(titles(desc, [high, med, low]), ["c-low", "b-med", "a-high"]);
});

test("sortCmpFor: unschema'd select values trail the known options (SUB-309)", () => {
  const schema: Record<string, PropSchema> = {
    priority: { options: [{ value: "High" }, { value: "Medium" }, { value: "Low" }] },
  };
  const high = note("a-high", { priority: "High" });
  const strayU = note("d-urgent", { priority: "Urgent" });
  const strayB = note("e-blocker", { priority: "blocker" });
  const none = note("z-none", {});
  // known options first in option order, strays after — lexicographic among
  // themselves (base-insensitive: blocker < Urgent) — missing values last
  const asc = sortCmpFor([{ key: "priority", dir: 1 }], schema)!;
  assert.deepEqual(titles(asc, [strayU, none, strayB, high]), ["a-high", "e-blocker", "d-urgent", "z-none"]);
  // DESC keeps unschema'd values BEHIND the known options — "last option
  // first" must not lead with junk. The classification is direction-independent
  // like the missing-values rule; only the within-class comparisons flip, so
  // the strays reverse among themselves (Urgent before blocker) and the
  // missing row keeps its tail slot.
  const desc = sortCmpFor([{ key: "priority", dir: -1 }], schema)!;
  assert.deepEqual(titles(desc, [high, none, strayB, strayU]), ["a-high", "d-urgent", "e-blocker", "z-none"]);
  // with several known options the desc order is option order reversed, then
  // the strays, then missing
  const med = note("b-med", { priority: "Medium" });
  const low = note("c-low", { priority: "Low" });
  assert.deepEqual(
    titles(desc, [strayB, high, none, low, strayU, med]),
    ["c-low", "b-med", "a-high", "d-urgent", "e-blocker", "z-none"]
  );
});

test("sortCmpFor: non-select keys keep the lexicographic path even with a schema (SUB-309)", () => {
  const schema: Record<string, PropSchema> = {
    // multi-kind carries options too, but a note's joined list has no single
    // option slot — it sorts as a string, as before
    tags: { options: [{ value: "zeta" }, { value: "alpha" }], kind: "multi" },
    // a kindless entry with no options is a text column (SelectMenu's rule)
    status: { options: [] },
  };
  const byTags = sortCmpFor([{ key: "tags", dir: 1 }], schema)!;
  const zeta = note("b-zeta", { tags: "zeta" });
  const alpha = note("a-alpha", { tags: "alpha" });
  assert.deepEqual(titles(byTags, [zeta, alpha]), ["a-alpha", "b-zeta"]);
  const byStatus = sortCmpFor([{ key: "status", dir: 1 }], schema)!;
  const live = note("b-live", { status: "live" });
  const parked = note("a-parked", { status: "parked" });
  assert.deepEqual(titles(byStatus, [parked, live]), ["b-live", "a-parked"]);
  // a sort key the schema doesn't mention at all: unchanged as well
  const byOther = sortCmpFor([{ key: "artist", dir: 1 }], schema)!;
  assert.deepEqual(titles(byOther, [note("b", { artist: "moss" }), note("a", { artist: "ash" })]), ["a", "b"]);
});

test("cycleSortKeys: plain click replaces and cycles asc → desc → none", () => {
  const asc = cycleSortKeys([], "status", false);
  assert.deepEqual(asc, [{ key: "status", dir: 1 }]);
  const desc = cycleSortKeys(asc, "status", false);
  assert.deepEqual(desc, [{ key: "status", dir: -1 }]);
  assert.deepEqual(cycleSortKeys(desc, "status", false), []);
  // a plain click on another key discards every existing key
  const multi: SavedViewSort[] = [
    { key: "status", dir: 1 },
    { key: "title", dir: -1 },
  ];
  assert.deepEqual(cycleSortKeys(multi, "artist", false), [{ key: "artist", dir: 1 }]);
  // …even when that key was in the list
  assert.deepEqual(cycleSortKeys(multi, "title", false), [{ key: "title", dir: 1 }]);
});

test("cycleSortKeys: shift-click appends, cycles in place, removes", () => {
  const one = cycleSortKeys([{ key: "status", dir: 1 }], "title", true);
  assert.deepEqual(one, [
    { key: "status", dir: 1 },
    { key: "title", dir: 1 },
  ]);
  // shift-clicking the appended key flips only its own dir
  const flipped = cycleSortKeys(one, "title", true);
  assert.deepEqual(flipped, [
    { key: "status", dir: 1 },
    { key: "title", dir: -1 },
  ]);
  // and again drops it — the surviving primary stays put
  assert.deepEqual(cycleSortKeys(flipped, "title", true), [{ key: "status", dir: 1 }]);
  // shift-clicking the PRIMARY desc then removes it, promoting the secondary
  const two: SavedViewSort[] = [
    { key: "status", dir: -1 },
    { key: "title", dir: 1 },
  ];
  assert.deepEqual(cycleSortKeys(two, "status", true), [{ key: "title", dir: 1 }]);
});

test("cycleSortKeys: the list caps at MAX_SORT_KEYS", () => {
  let cur: SavedViewSort[] = [];
  for (const k of ["a", "b", "c"]) cur = cycleSortKeys(cur, k, true);
  assert.equal(cur.length, MAX_SORT_KEYS);
  // a fourth shift-clicked key is ignored; existing keys still cycle
  assert.deepEqual(cycleSortKeys(cur, "d", true), cur);
  assert.deepEqual(cycleSortKeys(cur, "a", true).map((s) => s.key), ["a", "b", "c"]);
  assert.equal(MAX_SORT_KEYS, 3);
});
