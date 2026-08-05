import { test } from "node:test";
import assert from "node:assert/strict";
import { embedQueryFor, parseViewSpec, EMBED_MAX_ROWS } from "./embeds.ts";
import { isJoinName } from "./viewjoin.ts";
import { filterByQuery } from "./views.ts";
import type { EmbedResult } from "./embeds.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

/* View-fence joins: dotted `relation.prop` lookup columns. */

function note(title: string, props: Record<string, unknown>, stem = title): NoteMeta {
  return {
    path: `${title}.md`,
    stem,
    title,
    folder: "",
    props: props as NoteMeta["props"],
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES: NoteMeta[] = [
  note("Slow Bloom EP", { type: "release", status: "live", date: "2026-03-01", catalog: "SMP-030" }),
  note("Vessel Songs", { type: "release", status: "mastering", date: "2026-01-15", catalog: "SMP-029" }),
  note("Static Bouquet", { type: "release", status: "archived", date: "2026-07-04" }),
  note("Master A", { type: "master", stage: "cut", release: "Slow Bloom EP" }),
  note("Master B", { type: "master", stage: "queued", release: "Vessel Songs" }),
  note("Master C", { type: "master", stage: "queued", release: "Ghost Record" }), // dangling
  note("Master D", { type: "master", stage: "done" }), // no relation value
  note("Master E", { type: "master", stage: "done", release: "Static Bouquet" }), // target lacks catalog
];

const SCHEMA: SchemaConfig = {
  release: {
    status: { options: [{ value: "live" }, { value: "mastering" }, { value: "archived" }] },
    date: { options: [], kind: "date" },
    catalog: { options: [] },
    plays: { options: [], kind: "rollup", relation: "x", prop: "y", agg: "sum" },
  },
  master: {
    stage: { options: [] },
    release: { options: [], kind: "relation", type: "release" },
    engineer: { options: [] },
  },
};

function run(fence: string, notes: NoteMeta[] = NOTES): EmbedResult {
  return embedQueryFor(parseViewSpec(fence), notes, SCHEMA, []);
}

function ok(result: EmbedResult) {
  assert.ok(!("error" in result), "error" in result ? result.error : "");
  return result as Exclude<EmbedResult, { error: string }>;
}

const cell = (r: Exclude<EmbedResult, { error: string }>, title: string, col: string): string =>
  r.rows.find((row) => row.title === title)!.cells[r.columns.indexOf(col)];

/* ---------- item 1: dotted columns render the target's stored prop ---------- */

test("a dotted column shows the named stored prop of the row the relation names", () => {
  const r = ok(run("type: master\ncolumns: stage, release.catalog\n"));
  assert.deepEqual(r.columns, ["stage", "release.catalog"]);
  assert.equal(cell(r, "Master A", "release.catalog"), "SMP-030");
  assert.equal(cell(r, "Master B", "release.catalog"), "SMP-029");
});

test("the relation and the target prop both resolve case-insensitively", () => {
  const r = ok(run("type: master\ncolumns: Release.CATALOG\n"));
  // the column renders under the canonical schema spellings, like every other
  // column name the fence resolves
  assert.deepEqual(r.columns, ["release.catalog"]);
  assert.equal(cell(r, "Master A", "release.catalog"), "SMP-030");
});

test("a target row matched by stem, not only by title (the rollup's rule)", () => {
  const notes = [
    note("Renamed Title", { type: "release", catalog: "SMP-100" }, "orig-stem"),
    note("Master S", { type: "master", release: "orig-stem" }),
  ];
  const r = ok(run("type: master\ncolumns: release.catalog\n", notes));
  assert.equal(cell(r, "Master S", "release.catalog"), "SMP-100");
});

test("two target rows sharing a title are indistinguishable — the first wins", () => {
  const notes = [
    note("Twin", { type: "release", catalog: "FIRST" }),
    { ...note("Twin", { type: "release", catalog: "SECOND" }), path: "Twin-2.md", stem: "Twin-2" },
    note("Master T", { type: "master", release: "Twin" }),
  ];
  const r = ok(run("type: master\ncolumns: release.catalog\n", notes));
  assert.equal(cell(r, "Master T", "release.catalog"), "FIRST");
});

test("a joined date renders through the target column's own kind", () => {
  const r = ok(run("type: master\ncolumns: release.date\n"));
  // date-kind on `release`, so the cell is humanized exactly as the release
  // table renders it — not the raw ISO string
  assert.notEqual(cell(r, "Master A", "release.date"), "2026-03-01");
  assert.match(cell(r, "Master A", "release.date"), /2026/);
});

/* ---------- item 2: blank-cell semantics ---------- */

test("relation absent, dangling target, and missing target prop are all blank", () => {
  const r = ok(run("type: master\ncolumns: release.catalog\n"));
  assert.equal(cell(r, "Master D", "release.catalog"), ""); // no relation value
  assert.equal(cell(r, "Master C", "release.catalog"), ""); // dangling target
  assert.equal(cell(r, "Master E", "release.catalog"), ""); // target lacks the prop
});

test("a blank data condition never becomes an error card", () => {
  const notes = [note("Master Z", { type: "master", release: "Nothing At All" })];
  const r = ok(run("type: master\ncolumns: release.catalog\n", notes));
  assert.equal(r.rows.length, 1);
  assert.equal(cell(r, "Master Z", "release.catalog"), "");
});

/* ---------- item 3: authoring errors as quiet cards ---------- */

test("a base prop that isn't a relation is an authoring error", () => {
  const r = run("type: master\ncolumns: stage.catalog\n");
  assert.deepEqual(r, { error: "“stage” isn't a relation property on “master”" });
});

test("an unknown property on the target database is an authoring error", () => {
  const r = run("type: master\ncolumns: release.nope\n");
  assert.deepEqual(r, { error: "Unknown property “nope” on “release”" });
});

test("more than one dot is one hop too many", () => {
  const r = run("type: master\ncolumns: release.artist.name\n");
  assert.deepEqual(r, {
    error: "“release.artist.name” goes more than one hop — a join follows one relation",
  });
});

test("an empty side of the dot is malformed, not a crash", () => {
  assert.deepEqual(run("type: master\ncolumns: release.\n"), {
    error: "Malformed column “release.” — want relation.property",
  });
  assert.deepEqual(run("type: master\ncolumns: .catalog\n"), {
    error: "Malformed column “.catalog” — want relation.property",
  });
});

test("a dotted sort key reports the same authoring errors", () => {
  assert.deepEqual(run("type: master\nsort: stage.catalog\n"), {
    error: "“stage” isn't a relation property on “master”",
  });
  assert.deepEqual(run("type: master\nsort: release.nope:desc\n"), {
    error: "Unknown property “nope” on “release”",
  });
});

/* ---------- item 4: no row multiplication, comma-join, read-only, stored only ---------- */

test("a list-valued relation joins its looked-up values in stored order", () => {
  const notes = [
    ...NOTES,
    note("Master M", { type: "master", release: ["Vessel Songs", "Slow Bloom EP"] }),
  ];
  const r = ok(run("type: master\ncolumns: release.catalog\n", notes));
  assert.equal(cell(r, "Master M", "release.catalog"), "SMP-029, SMP-030");
});

test("a join never multiplies rows — it only adds a column", () => {
  const notes = [
    ...NOTES,
    note("Master M", { type: "master", release: ["Vessel Songs", "Slow Bloom EP"] }),
  ];
  const plain = ok(run("type: master\ncolumns: stage\n", notes));
  const joined = ok(run("type: master\ncolumns: stage, release.catalog\n", notes));
  assert.equal(joined.rows.length, plain.rows.length);
  assert.equal(joined.total, plain.total);
  assert.deepEqual(
    joined.rows.map((row) => row.path),
    plain.rows.map((row) => row.path)
  );
});

test("joined columns are announced as read-only", () => {
  const r = ok(run("type: master\ncolumns: stage, release.catalog\n"));
  assert.deepEqual(r.joins, ["release.catalog"]);
  // a fence with no joins doesn't carry the key at all
  assert.equal(ok(run("type: master\ncolumns: stage\n")).joins, undefined);
});

test("a joined cell never lands in the row's own props", () => {
  const r = ok(run("type: master\ncolumns: release.catalog\n"));
  for (const row of r.rows) assert.equal("release.catalog" in row.props, false);
});

test("lookups read STORED values only — a rollup prop on the target reads nothing", () => {
  // `plays` is a rollup on `release`: derived values never land in props, so
  // the join finds nothing there, exactly as a rollup-of-rollup does
  const r = ok(run("type: master\ncolumns: release.plays\n"));
  for (const row of r.rows) assert.equal(row.cells[0], "");
});

test("a name listed twice is one column, kept at its first position", () => {
  const r = ok(run("type: master\ncolumns: release.catalog, stage, Release.Catalog\n"));
  assert.deepEqual(r.columns, ["release.catalog", "stage"]);
});

/* ---------- item 5: sort computes before the cut ---------- */

test("sort on a dotted column orders by the target's value, under its kind", () => {
  const r = ok(run("type: master\nsort: release.date:desc\ncolumns: release.date\n"));
  assert.deepEqual(
    r.rows.map((row) => row.title),
    // 2026-07-04, 2026-03-01, 2026-01-15, then the two with no value
    ["Master E", "Master A", "Master B", "Master C", "Master D"]
  );
});

test("ascending is the same order reversed, with valueless rows still last", () => {
  const r = ok(run("type: master\nsort: release.date\ncolumns: release.date\n"));
  assert.deepEqual(
    r.rows.slice(0, 3).map((row) => row.title),
    ["Master B", "Master A", "Master E"]
  );
  assert.deepEqual(
    r.rows.slice(3).map((row) => row.title).sort(),
    ["Master C", "Master D"]
  );
});

test("sort on a joined column runs over all matched rows, before the limit cut", () => {
  const r = ok(run("type: master\nsort: release.date:desc\nlimit: 1\ncolumns: release.date\n"));
  assert.equal(r.total, 5);
  assert.equal(r.rows.length, 1);
  // the newest of ALL five, not the first row of the pre-cut vault order
  assert.equal(r.rows[0].title, "Master E");
});

test("sort on a joined column runs before the surface cap too", () => {
  const many: NoteMeta[] = [note("Anchor", { type: "release", date: "1999-01-01" })];
  for (let i = 0; i < EMBED_MAX_ROWS + 10; i += 1) {
    many.push(note(`Rel ${i}`, { type: "release", date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` }));
    many.push(note(`M ${i}`, { type: "master", release: `Rel ${i}` }));
  }
  // the oldest target is linked by the LAST master, well past the cap
  many.push(note("Oldest", { type: "master", release: "Anchor" }));
  const r = ok(run("type: master\nsort: release.date\ncolumns: release.date\n", many));
  assert.equal(r.rows.length, EMBED_MAX_ROWS);
  assert.equal(r.cut?.kind, "cap");
  assert.equal(r.rows[0].title, "Oldest");
});

test("a joined select column sorts by the target's declared option order", () => {
  const r = ok(run("type: master\nsort: release.status\ncolumns: release.status\n"));
  assert.deepEqual(
    r.rows.slice(0, 3).map((row) => row.title),
    ["Master A", "Master B", "Master E"] // live, mastering, archived
  );
});

/* ---------- item 6: query: on a dotted key is out of v1 ---------- */

test("a dotted query key is not a filter — it falls through to the existing word match", () => {
  // parseQuery's key charclass excludes `.`, so the token is a bare text word
  // matched case-insensitively against note TITLES (src/lib/views.ts). No
  // crash, no error, no grammar change.
  const r = ok(run("type: master\nquery: release.catalog:SMP-030\n"));
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  const hit = ok(run("type: master\nquery: master.a\n"));
  assert.equal(hit.total, 0);
  // and the same string against titles does match when it is a substring
  assert.equal(filterByQuery(NOTES, "release.catalog:SMP-030").length, 0);
});

/* ---------- the detector itself: a stored column wins over a join ---------- */

test("isJoinName reads a dot as a join only when the database has no such column", () => {
  const cols = ["status", "cat#", "v1.2"];
  assert.equal(isJoinName("release.date", cols), true);
  assert.equal(isJoinName("status", cols), false);
  assert.equal(isJoinName("cat#", cols), false);
  // a stored key that happens to carry a dot is a column, not a join
  assert.equal(isJoinName("v1.2", cols), false);
  // and it resolves case-insensitively, like every other column name
  assert.equal(isJoinName("V1.2", cols), false);
});

test("a stored prop whose name carries a dot renders as a plain column", () => {
  // the regression: nothing forbids a dot in a frontmatter key, and before the
  // precedence rule this fence errored ("v1" isn't a relation property)
  const notes = [
    note("Take 1", { type: "take", "v1.2": "keeper", stage: "rough" }),
    note("Take 2", { type: "take", "v1.2": "scratch" }),
  ];
  const r = ok(run("type: take\ncolumns: stage, v1.2\n", notes));
  assert.deepEqual(r.columns, ["stage", "v1.2"]);
  assert.equal(cell(r, "Take 1", "v1.2"), "keeper");
  assert.equal(cell(r, "Take 2", "v1.2"), "scratch");
  // it is a stored column, so it is NOT read-only
  assert.equal(r.joins, undefined);
});

test("a dotted stored prop sorts as its own column, not through a relation", () => {
  const notes = [
    note("Take A", { type: "take", "v1.2": "b" }),
    note("Take B", { type: "take", "v1.2": "a" }),
  ];
  const r = ok(run("type: take\nsort: v1.2\ncolumns: v1.2\n", notes));
  assert.deepEqual(
    r.rows.map((row) => row.title),
    ["Take B", "Take A"]
  );
});

test("a stored column shadows a would-be join of the same name, in columns AND sort", () => {
  // `release.date` is BOTH a legal lookup (relation `release` → prop `date`)
  // and a stored key on the base row. The author's stored value wins.
  const notes = [
    note("Rel", { type: "release", date: "2026-03-01" }),
    note("Job", { type: "master", release: "Rel", "release.date": "hand-written" }),
  ];
  const r = ok(run("type: master\ncolumns: release.date\nsort: release.date\n", notes));
  assert.equal(cell(r, "Job", "release.date"), "hand-written");
  assert.equal(r.joins, undefined);
});

test("a sort-only join never attaches to a display column of the same name", () => {
  // the shadowing bug: `sort:` resolved a join, and the FINAL column list was
  // then name-matched against the resolved-joins map, so the stored column
  // `release.date` silently rendered the looked-up value and went read-only.
  // Here the stored key is spelled to collide with the join's canonical name
  // while the join is reached only through `sort:` — with a schema declaring
  // it, so it is a real column of `master` and wins the columns list.
  const schema: SchemaConfig = {
    release: { date: { options: [], kind: "date" } },
    master: {
      release: { options: [], kind: "relation", type: "release" },
      "release.date": { options: [] },
    },
  };
  const notes = [
    note("Rel", { type: "release", date: "2026-03-01" }),
    note("Job", { type: "master", release: "Rel", "release.date": "mine" }),
  ];
  const r = embedQueryFor(
    parseViewSpec("type: master\ncolumns: release.date\nsort: release.date\n"),
    notes,
    schema,
    []
  );
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  const okr = r as Exclude<EmbedResult, { error: string }>;
  assert.equal(cell(okr, "Job", "release.date"), "mine");
  assert.equal(okr.joins, undefined);
});

test("sorting by a lookup does not add it as a column", () => {
  const r = ok(run("type: master\nsort: release.date:desc\ncolumns: stage\n"));
  assert.deepEqual(r.columns, ["stage"]);
  assert.equal(r.joins, undefined);
  for (const row of r.rows) assert.equal("release.date" in row.props, false);
});

/* ---------- SHOULD-FIX 4: an empty or schemaless target blanks ---------- */

test("a schemaless target with no rows blanks rather than erroring", () => {
  const schema: SchemaConfig = {
    master: { release: { options: [], kind: "relation", type: "release" } },
  };
  const notes = [note("Master N", { type: "master", release: "Nothing Yet" })];
  const r = embedQueryFor(
    parseViewSpec("type: master\ncolumns: release.catalog\n"),
    notes,
    schema,
    []
  );
  assert.ok(!("error" in r), "error" in r ? r.error : "");
  const okr = r as Exclude<EmbedResult, { error: string }>;
  assert.deepEqual(okr.columns, ["release.catalog"]);
  assert.equal(cell(okr, "Master N", "release.catalog"), "");
  assert.deepEqual(okr.joins, ["release.catalog"]);
});

test("a target whose rows haven't filled a prop yet blanks, and fills as rows arrive", () => {
  // the target type is schemaless: `catalog` is neither declared nor observed,
  // which is a data condition, not a typo — no vocabulary exists to be wrong
  // against
  const schema: SchemaConfig = {
    master: { release: { options: [], kind: "relation", type: "release" } },
  };
  const bare = [
    note("Rel", { type: "release" }),
    note("Master N", { type: "master", release: "Rel" }),
  ];
  const blank = embedQueryFor(
    parseViewSpec("type: master\ncolumns: release.catalog\n"),
    bare,
    schema,
    []
  );
  assert.ok(!("error" in blank), "error" in blank ? blank.error : "");
  assert.equal(cell(blank as Exclude<EmbedResult, { error: string }>, "Master N", "release.catalog"), "");

  const filled = embedQueryFor(
    parseViewSpec("type: master\ncolumns: release.catalog\n"),
    [note("Rel", { type: "release", catalog: "SMP-777" }), note("Master N", { type: "master", release: "Rel" })],
    schema,
    []
  );
  assert.ok(!("error" in filled), "error" in filled ? filled.error : "");
  assert.equal(
    cell(filled as Exclude<EmbedResult, { error: string }>, "Master N", "release.catalog"),
    "SMP-777"
  );
});

test("a schema-declared prop resolves on a zero-row target", () => {
  // `release` declares `catalog` but no release note exists yet — the column
  // is real, its cells are simply empty
  const notes = [note("Master N", { type: "master", release: "Not Yet" })];
  const r = ok(run("type: master\ncolumns: release.catalog\n", notes));
  assert.deepEqual(r.columns, ["release.catalog"]);
  assert.equal(cell(r, "Master N", "release.catalog"), "");
});

test("a typo against a SCHEMA'd target is still an authoring error", () => {
  // `release` declares properties, so it has a vocabulary and can say no
  assert.deepEqual(run("type: master\ncolumns: release.nope\n"), {
    error: "Unknown property “nope” on “release”",
  });
});

/* ---------- SHOULD-FIX 5: relation.title resolves ---------- */

test("relation.title looks up the target row's display name", () => {
  const r = ok(run("type: master\ncolumns: release.title\n"));
  assert.deepEqual(r.columns, ["release.title"]);
  assert.equal(cell(r, "Master A", "release.title"), "Slow Bloom EP");
  assert.equal(cell(r, "Master B", "release.title"), "Vessel Songs");
  // a dangling value still links nothing
  assert.equal(cell(r, "Master C", "release.title"), "");
  assert.deepEqual(r.joins, ["release.title"]);
});

test("relation.title resolves case-insensitively and sorts", () => {
  const r = ok(run("type: master\nsort: release.TITLE\ncolumns: release.Title\n"));
  assert.deepEqual(r.columns, ["release.title"]);
  assert.deepEqual(
    r.rows.slice(0, 3).map((row) => row.title),
    ["Master A", "Master E", "Master B"] // Slow Bloom EP, Static Bouquet, Vessel Songs
  );
});

test("relation.type stays excluded — a type is constant per database, not a value", () => {
  assert.deepEqual(run("type: master\ncolumns: release.type\n"), {
    error: "Unknown property “type” on “release”",
  });
});

/* ---------- SHOULD-FIX 6: list-valued lookups sort kind-aware ---------- */

test("a list-valued lookup sorts by its best value, not by the joined string", () => {
  // "Master M" holds the newest release of all. Comma-joining its two dates
  // and sorting that string made it valueless — it sorted last under desc.
  const notes = [
    note("Rel Old", { type: "release", date: "2020-01-01" }),
    note("Rel New", { type: "release", date: "2030-01-01" }),
    note("Rel Mid", { type: "release", date: "2025-01-01" }),
    note("Master M", { type: "master", release: ["Rel Old", "Rel New"] }),
    note("Master S", { type: "master", release: "Rel Mid" }),
  ];
  const desc = ok(run("type: master\nsort: release.date:desc\ncolumns: release.date\n", notes));
  assert.deepEqual(
    desc.rows.map((row) => row.title),
    ["Master M", "Master S"] // 2030 beats 2025
  );
  const asc = ok(run("type: master\nsort: release.date\ncolumns: release.date\n", notes));
  assert.deepEqual(
    asc.rows.map((row) => row.title),
    ["Master M", "Master S"] // 2020 beats 2025 the other way too
  );
});

test("the list's DISPLAY stays comma-joined in stored order while sorting picks one", () => {
  const notes = [
    note("Rel Old", { type: "release", catalog: "AAA" }),
    note("Rel New", { type: "release", catalog: "ZZZ" }),
    note("Master M", { type: "master", release: ["Rel New", "Rel Old"] }),
  ];
  const r = ok(run("type: master\nsort: release.catalog:desc\ncolumns: release.catalog\n", notes));
  assert.equal(cell(r, "Master M", "release.catalog"), "ZZZ, AAA");
});

test("a list of values that don't parse ranks exactly as one of them would alone", () => {
  // The comparator doesn't treat an unparsable date as MISSING — it falls back
  // to collating the raw strings (dbsort.ts) — so the guarantee here is
  // narrower and more useful: whatever a single junk value would do, a list of
  // junk values does too. Only a row with nothing to look up sorts last.
  const rels = [
    note("Rel Junk A", { type: "release", date: "not a date" }),
    note("Rel Junk B", { type: "release", date: "also not" }),
    note("Rel Real", { type: "release", date: "2026-01-01" }),
  ];
  const listed = ok(
    run("type: master\nsort: release.date:desc\ncolumns: release.date\n", [
      ...rels,
      note("Master J", { type: "master", release: ["Rel Junk A", "Rel Junk B"] }),
      note("Master R", { type: "master", release: "Rel Real" }),
      note("Master Empty", { type: "master" }),
    ])
  );
  const alone = ok(
    run("type: master\nsort: release.date:desc\ncolumns: release.date\n", [
      ...rels,
      note("Master J", { type: "master", release: "Rel Junk A" }),
      note("Master R", { type: "master", release: "Rel Real" }),
      note("Master Empty", { type: "master" }),
    ])
  );
  assert.deepEqual(
    listed.rows.map((row) => row.title),
    alone.rows.map((row) => row.title)
  );
  // a row with no values at all is still last in both directions
  assert.equal(listed.rows[listed.rows.length - 1].title, "Master Empty");
  const asc = ok(
    run("type: master\nsort: release.date\ncolumns: release.date\n", [
      ...rels,
      note("Master J", { type: "master", release: ["Rel Junk A", "Rel Junk B"] }),
      note("Master R", { type: "master", release: "Rel Real" }),
      note("Master Empty", { type: "master" }),
    ])
  );
  assert.equal(asc.rows[asc.rows.length - 1].title, "Master Empty");
});
