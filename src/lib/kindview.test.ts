/** `ctx.view` — a saved view, evaluated by the app's own evaluator.
 *
 *  `vieweval.test.ts` owns what the evaluator does; what is pinned here is
 *  the door: the name folds, the rows and cells are spelled out rather than
 *  compared against the same call the door makes, the database's grouping
 *  reaches a kind the way it reaches the pane, what comes back is the kind's
 *  to mutate, and a name no pin carries refuses by name rather than answering
 *  as an empty view. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteMeta, SavedView, SchemaConfig, ViewsConfig } from "./types.ts";
import { kindView } from "./kindview.ts";

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

const NOTES = [
  note("Kettle", { type: "release", status: "live", stage: "mix" }),
  note("Glass Bridge", { type: "release", status: "parked", stage: "master" }),
  note("Harbour", { type: "release", status: "live", stage: "mix" }),
];

const SCHEMA = {
  release: {
    status: { options: [{ value: "live" }, { value: "parked" }] },
    stage: { options: [{ value: "mix" }, { value: "master" }] },
  },
} as unknown as SchemaConfig;

const LIVE: SavedView = { id: "v1", name: "Live only", db: "release", query: "status:live" };

test("a pin evaluates to the table the app's own evaluator paints from it", () => {
  const got = kindView("Live only", [LIVE], NOTES, SCHEMA);
  assert.ok("view" in got);
  // spelled out rather than compared against the same `evaluateSavedView`
  // call the door itself makes: that assertion passed whatever the door did
  assert.equal(got.view.schema, "substrate.view/1");
  assert.deepEqual(got.view.view, { id: "v1", name: "Live only", db: "release", query: "status:live" });
  assert.equal(got.view.total, 2);
  assert.equal(got.view.group_by, null);
  assert.deepEqual(got.view.groups, []);
  assert.deepEqual(
    got.view.rows.map((r) => r.title),
    // the pin's own order — no sort key, so the evaluator's default one
    ["Harbour", "Kettle"],
  );
  assert.deepEqual(
    got.view.rows.map((r) => r.path),
    ["Harbour.md", "Kettle.md"],
  );
  // no `kind` on the schema entry, so the cell carries none — raw and painted
  assert.deepEqual(got.view.rows[0].cells.status, { raw: "live", display: "live" });
});

test("the pin's own sorts come back copied — a kind cannot reorder App's pin", () => {
  const pinned: SavedView = {
    id: "v3",
    name: "Sorted",
    db: "release",
    sorts: [{ key: "title", dir: -1 }, { key: "status", dir: 1 }],
  };
  const before = JSON.stringify(pinned);
  const got = kindView("Sorted", [pinned], NOTES, SCHEMA);
  assert.ok("view" in got);
  assert.deepEqual(got.view.sorts, [
    { key: "title", dir: -1 },
    { key: "status", dir: 1 },
  ]);
  got.view.sorts[0].dir = 1;
  got.view.sorts.reverse();
  got.view.sorts.push({ key: "folder", dir: -1 });
  assert.equal(JSON.stringify(pinned), before);
});

test("a single-key pin's sort is copied too — that alias was the same object", () => {
  const pinned: SavedView = { id: "v4", name: "One key", db: "release", sort: { key: "title", dir: 1 } };
  const got = kindView("One key", [pinned], NOTES, SCHEMA);
  assert.ok("view" in got);
  got.view.sorts[0].dir = -1;
  assert.deepEqual(pinned.sort, { key: "title", dir: 1 });
});

test("the database's grouping reaches a kind, the way it reaches the pane", () => {
  // the pin captures no grouping; the database's `table_group_by` is what the
  // database pane composes under it, so a kind must section where the pane does
  const prefs = {
    release: { view: "table", table_group_by: "status" },
  } as unknown as ViewsConfig;
  const all: SavedView = { id: "v5", name: "Everything", db: "release" };
  const flat = kindView("Everything", [all], NOTES, SCHEMA);
  assert.ok("view" in flat);
  assert.equal(flat.view.group_by, null);
  assert.deepEqual(flat.view.groups, []);

  const grouped = kindView("Everything", [all], NOTES, SCHEMA, { prefs });
  assert.ok("view" in grouped);
  assert.equal(grouped.view.group_by, "status");
  assert.deepEqual(
    grouped.view.groups.map((g) => [g.value, g.label, g.count]),
    [
      ["live", "live", 2],
      ["parked", "parked", 1],
    ],
  );
  // the database name folds in that lookup, like every other reader of the map
  const folded = kindView("Everything", [all], NOTES, SCHEMA, {
    prefs: { Release: { view: "table", table_group_by: "status" } } as unknown as ViewsConfig,
  });
  assert.ok("view" in folded);
  assert.equal(folded.view.group_by, "status");
});

test("the pin's own grouping still wins over the database's", () => {
  const prefs = {
    release: { view: "table", table_group_by: "status" },
  } as unknown as ViewsConfig;
  const own: SavedView = { id: "v6", name: "By stage", db: "release", table_group_by: "stage" };
  const got = kindView("By stage", [own], NOTES, SCHEMA, { prefs });
  assert.ok("view" in got);
  assert.equal(got.view.group_by, "stage");
});

test("the name folds, like every user-authored identity in the vault", () => {
  for (const spelling of ["live only", "  LIVE ONLY  ", "Live Only"]) {
    const got = kindView(spelling, [LIVE], NOTES, SCHEMA);
    assert.ok("view" in got, spelling);
    assert.equal(got.view.total, 2);
  }
});

test("a name no pin carries refuses by name, and does not read as an empty view", () => {
  assert.deepEqual(kindView("Nothing named this", [LIVE], NOTES, SCHEMA), {
    refusal: "no saved view named “Nothing named this”",
  });
  assert.deepEqual(kindView("Live only", [], NOTES, SCHEMA), {
    refusal: "no saved view named “Live only”",
  });
});

test("a pin over a database with no registered schema still evaluates", () => {
  // the pane hands `{}` there too — an unregistered database is an ordinary
  // state, not a reason to refuse a pin that names it
  const loose: SavedView = { id: "v2", name: "All moods", db: "moodboard" };
  const got = kindView("All moods", [loose], [note("Fog", { type: "moodboard" })], SCHEMA);
  assert.ok("view" in got);
  assert.equal(got.view.total, 1);
});
