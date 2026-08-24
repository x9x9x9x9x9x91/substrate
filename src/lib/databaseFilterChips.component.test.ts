/** The database filter row's active-filter chips, through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    The chips are a view over the query STRING — there is no second filter
    model — so what has to be pinned is the round trip: a mixed query renders
    as chips, a chip edit rewrites the string, and the rewritten string parses
    back to the filter the chip now shows. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import { parseQuery } from "./query.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const SCHEMA: Record<string, PropSchema> = {
  Status: {
    options: [
      { value: "live", color: "green" },
      { value: "mixing", color: "blue" },
      { value: "mastering", color: "violet" },
    ],
  },
  cut: { options: [] },
  rating: { options: [], kind: "number" },
};

function row(title: string, status: string, cut: string, rating: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: "Release", Status: status, cut, rating },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const ROWS = [
  row("Slow Bloom EP", "live", "album", "9"),
  row("Dust Harbour", "mixing", "single", "4"),
  row("Ganglion", "live", "single", "7"),
];

/** DatabasePane's required props, with everything these tests don't drive
    inert — the `databaseFilterEnter` fixture, which pins the same row. */
function paneProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: "Release",
    notes: ROWS,
    allNotes: ROWS,
    pref: { view: "list" },
    typeSchema: SCHEMA,
    schema: { Release: SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: ["Release"],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    onPrefChange: () => {},
    onOpenNote: () => {},
    onNoteMenu: () => {},
    onTrashNotes: () => {},
    onMutated: () => {},
    onSaveView: () => {},
    savedViews: [],
    pinKeys: {},
    onOpenView: () => {},
    onViewMenu: () => {},
    onRenameDb: () => {},
    onDeleteDb: () => {},
    onRenameProp: () => {},
    onRemoveProp: () => {},
    ...over,
  };
}

interface Rendered {
  text(): string;
  one(sel: string): Element | null;
  all(sel: string): Element[];
  click(target: string | Element): Promise<void>;
}

/** The pane opened on a query, the way a saved view opens it — the chips are
    what a reader meets before they have typed anything at all. */
async function openOn(t: Parameters<typeof renderComponent>[0], query: string): Promise<Rendered> {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return (await renderComponent(
    t,
    h(DatabasePane as never, paneProps({ initialQuery: query }) as never)
  )) as unknown as Rendered;
}

const filterValue = (r: Rendered): string => (r.one(".db-filter-input") as HTMLInputElement).value;

/** One chip, read back the way the row reads: property, operator, value. */
function chips(r: Rendered): { key: string; op: string; value: string }[] {
  return r.all(".db-chip").map((chip) => ({
    key: chip.querySelector(".db-chip-key")?.textContent ?? "",
    op: chip.querySelector(".db-chip-op")?.textContent ?? "",
    value: chip.querySelector(".db-chip-val")?.textContent ?? "",
  }));
}

/** Click the menu row spelling `label`. */
async function pickMenuItem(r: Rendered, label: string): Promise<void> {
  const item = r
    .all(".db-chip-menu .dots-item")
    .find((el) => el.textContent?.trim() === label);
  assert.ok(item, `the menu offers "${label}"`);
  await r.click(item);
}

test("a mixed query renders one chip per active filter", async (t) => {
  const r = await openOn(t, "-cut:single rating >= 7 Status:live ");

  assert.deepEqual(chips(r), [
    { key: "cut", op: "is not", value: "single" },
    { key: "rating", op: "at least", value: "7" },
    { key: "Status", op: "is", value: "live" },
  ]);
  // the typed query is untouched and still the fast path
  assert.equal(filterValue(r), "-cut:single rating >= 7 Status:live ");
  // and the chips describe the rows that are actually on screen
  assert.match(r.text(), /Slow Bloom EP/, "live, album, 9 clears all three filters");
  assert.doesNotMatch(r.text(), /Dust Harbour/, "mixing is filtered out");
  assert.doesNotMatch(r.text(), /Ganglion/, "a single is filtered out");
});

test("a comparison chip offers the comparisons in words, and a flip rewrites the query", async (t) => {
  const r = await openOn(t, "rating >= 7 ");
  assert.match(r.text(), /Slow Bloom EP/, "9 and 7 are at least 7");
  assert.match(r.text(), /Ganglion/);

  await r.click(".db-chip-op");
  assert.deepEqual(
    r.all(".db-chip-menu .dots-item").map((el) => el.textContent?.trim()),
    ["is", "is not", "under", "at most", "over", "at least"],
    "a number property's own operators — and nothing the grammar cannot spell"
  );

  await pickMenuItem(r, "under");
  assert.equal(filterValue(r), "rating < 7 ", "the operator flip rewrote the string in place");
  assert.deepEqual(chips(r), [{ key: "rating", op: "under", value: "7" }]);
  assert.match(r.text(), /Dust Harbour/, "4 is under 7");
  assert.doesNotMatch(r.text(), /Ganglion/, "7 is not");
  assert.equal(r.all(".db-chip-menu").length, 0, "the menu closed on the pick");
});

test("is / is not flips a value filter without disturbing the rest of the query", async (t) => {
  const r = await openOn(t, 'slow Status:live "night drive" ');

  await r.click(".db-chip-op");
  await pickMenuItem(r, "is not");

  assert.equal(
    filterValue(r),
    'slow -Status:live "night drive" ',
    "only the filter's own span changed — words and phrases are byte-identical"
  );
  assert.deepEqual(chips(r), [{ key: "Status", op: "is not", value: "live" }]);
});

test("the value picker offers the property's options and rewrites through them", async (t) => {
  const r = await openOn(t, "Status:live ");
  assert.match(r.text(), /Slow Bloom EP/, "the two live rows are on screen");
  assert.match(r.text(), /Ganglion/);
  assert.doesNotMatch(r.text(), /Dust Harbour/);

  await r.click(".db-chip-val");
  assert.deepEqual(
    r.all(".db-chip-menu .dots-item").map((el) => el.textContent?.trim()),
    ["live", "mixing", "mastering"],
    "the schema's own options, in the schema's order"
  );
  assert.equal(
    r.all(".db-chip-menu .prop-check.on").length,
    1,
    "the value the filter already holds is checked"
  );

  // picking a second value builds the grammar's OR list
  await pickMenuItem(r, "mixing");
  assert.equal(filterValue(r), "Status:live,mixing ");
  assert.deepEqual(chips(r), [{ key: "Status", op: "is", value: "live, mixing" }]);
  assert.match(r.text(), /Dust Harbour/, "the mixing row joined the view");
  assert.match(r.text(), /Slow Bloom EP/, "and the live rows stayed");

  // unchecking the original leaves the filter on one value
  await pickMenuItem(r, "live");
  assert.equal(filterValue(r), "Status:mixing ");
  assert.match(r.text(), /Dust Harbour/);
  assert.doesNotMatch(r.text(), /Slow Bloom EP/);
});

test("a value the roster lacks still rides the menu, checked, and can be unchecked", async (t) => {
  // typed by hand or left behind by a saved query after an option was
  // removed: the menu must show the value it cannot offer, or the chip
  // holds a check nothing can clear
  const r = await openOn(t, "Status:archived ");
  await r.click(".db-chip-val");
  assert.deepEqual(
    r.all(".db-chip-menu .dots-item").map((el) => el.textContent?.trim()),
    ["live", "mixing", "mastering", "archived"],
    "the roster first, the chip's own stray value after it"
  );
  const on = r.all(".db-chip-menu .db-chip-value-item").filter(
    (el) => el.querySelector(".prop-check.on") !== null
  );
  assert.deepEqual(
    on.map((el) => el.textContent?.trim()),
    ["archived"],
    "the stray value is the one checked"
  );

  // unchecking the last value removes the filter, the same as the ✕ — and an
  // emptied untouched bar reclaims its space, so the whole row stands down
  await pickMenuItem(r, "archived");
  assert.equal(r.all(".db-chip").length, 0);
  assert.equal(r.all(".db-filter-input").length, 0, "the emptied bar left the screen");
});

test("a chip edit round-trips through the same parse the typed query uses", async (t) => {
  const query = "-cut:single rating >= 7 Status:live ";
  const r = await openOn(t, query);

  await r.click(r.all(".db-chip")[2].querySelector(".db-chip-op")!);
  await pickMenuItem(r, "is not");

  const rewritten = filterValue(r);
  assert.equal(rewritten, "-cut:single rating >= 7 -Status:live ");
  const parsed = parseQuery(rewritten, "2026-07-17", SCHEMA);
  assert.equal(parsed.filters.length, 3, "still three filters");
  assert.deepEqual(parsed.filters[2], { key: "status", values: ["live"], neg: true });
  // the chips the pane now draws say the same thing the parse does
  assert.deepEqual(chips(r), [
    { key: "cut", op: "is not", value: "single" },
    { key: "rating", op: "at least", value: "7" },
    { key: "Status", op: "is not", value: "live" },
  ]);
});

test("the ✕ removes one filter and its separator", async (t) => {
  const r = await openOn(t, "-cut:single rating >= 7 Status:live ");

  await r.click(r.all(".db-chip")[1].querySelector(".db-chip-x")!);
  assert.equal(filterValue(r), "-cut:single Status:live ");
  assert.deepEqual(chips(r), [
    { key: "cut", op: "is not", value: "single" },
    { key: "Status", op: "is", value: "live" },
  ]);
  assert.match(r.text(), /Slow Bloom EP/, "the rows the two remaining filters keep");
  assert.doesNotMatch(r.text(), /Dust Harbour/);
});

test("the chip row stands down when there is nothing committed to show", async (t) => {
  const r = await openOn(t, "Status:mix");

  assert.ok(r.one(".db-filter-input"), "the filter row is up");
  assert.equal(
    r.all(".db-chip").length,
    0,
    "a half-typed expression is the completion chips' business, not the overview's"
  );

  // and it appears the moment that expression commits
  await act(async () => {
    const field = r.one(".db-filter-input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      field,
      "Status:mixing "
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(chips(r), [{ key: "Status", op: "is", value: "mixing" }]);
});

test("unchecking the last value closes the menu with its chip", async (t) => {
  const r = await openOn(t, "Status:archived cut:album ");

  await r.click(r.all(".db-chip")[0].querySelector(".db-chip-val")!);
  await pickMenuItem(r, "archived");

  assert.equal(filterValue(r), "cut:album ", "the emptied filter is gone");
  assert.deepEqual(chips(r), [{ key: "cut", op: "is", value: "album" }]);
  assert.equal(
    r.all(".db-chip-menu").length,
    0,
    "no menu left open on whichever filter inherited the index"
  );
});

test("checking a second value keeps the first one's spelling", async (t) => {
  const r = await openOn(t, "Status:Live ");

  await r.click(".db-chip-val");
  await pickMenuItem(r, "mixing");

  assert.equal(filterValue(r), "Status:Live,mixing ", "the reader's casing survives the toggle");
});

test("a value the grammar cannot write back is not offered", async (t) => {
  const schema = {
    ...SCHEMA,
    Status: {
      options: [
        { value: "live", color: "green" },
        { value: '12" mix', color: "blue" },
      ],
    },
  };
  const r = (await renderComponent(
    (t as never),
    h(
      (await import("../components/DatabasePane.tsx")).default as never,
      paneProps({ initialQuery: "Status:live ", typeSchema: schema, schema: { Release: schema } }) as never
    )
  )) as unknown as Rendered;

  await r.click(".db-chip-val");
  assert.deepEqual(
    r.all(".db-chip-menu .dots-item").map((el) => el.textContent?.trim()),
    ["live"],
    'a quoted-quote value ("12\\" mix") has no writable spelling, so the menu refuses it'
  );
});

test("a date prefix value offers no comparison it cannot keep", async (t) => {
  const schema = { ...SCHEMA, due: { options: [], kind: "date" as const } };
  const r = (await renderComponent(
    (t as never),
    h(
      (await import("../components/DatabasePane.tsx")).default as never,
      paneProps({ initialQuery: "due:2026 ", typeSchema: schema, schema: { Release: schema } }) as never
    )
  )) as unknown as Rendered;

  await r.click(".db-chip-op");
  assert.deepEqual(
    r.all(".db-chip-menu .dots-item").map((el) => el.textContent?.trim()),
    ["is", "is not"],
    "no 'before' whose rewrite would silently stop being a filter"
  );
});
