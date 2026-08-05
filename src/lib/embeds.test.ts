import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_MAX_COLS,
  EMBED_MAX_ROWS,
  embedQueryFor,
  findSavedView,
  parseViewSpec,
  seedPropsFromQuery,
} from "./embeds.ts";
import type { NoteMeta, SavedView, SchemaConfig } from "./types.ts";

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

const RELEASES: NoteMeta[] = [
  note("Slow Bloom EP", { type: "release", status: "in review", "cat#": "SMP-030", artist: "various" }),
  note("Vessel Songs", { type: "release", status: "mastering", "cat#": "SMP-029", artist: "1k petals" }),
  note("Static Bouquet", { type: "release", status: "live", "cat#": "SMP-028", artist: "chroma weather" }),
];
const SCHEMA: SchemaConfig = {
  release: { status: { options: [{ value: "live" }] } },
};
const SAVED: SavedView[] = [
  { id: "unreleased", name: "Unreleased", db: "release", query: "status:mastering" },
];

/* ---------- parseViewSpec ---------- */

test("full form: type + query + view", () => {
  assert.deepEqual(parseViewSpec("type: release\nquery: status:unreleased\nview: table\n"), {
    type: "release",
    query: "status:unreleased",
    view: "table",
  });
});

test("saved one-key form", () => {
  assert.deepEqual(parseViewSpec("saved: umbra-unreleased"), {
    saved: "umbra-unreleased",
  });
});

test("blank lines and # comments are skipped, not judged", () => {
  assert.deepEqual(parseViewSpec("type: release\n\n# a note to self\ncolumns: status, artist"), {
    type: "release",
    columns: ["status", "artist"],
  });
});

test("an unknown key is an error, naming the keys that exist (SUB-942)", () => {
  const r = parseViewSpec("type: release\nsortt: status");
  assert.ok("error" in r);
  assert.match(r.error, /Unknown key “sortt”/);
  assert.match(r.error, /sort/);
});

test("a line that isn't key: value is an error, quoting it back (SUB-942)", () => {
  assert.deepEqual(parseViewSpec("type: release\nnot a kv line"), {
    error: "Not a key: value line — “not a kv line”",
  });
  const orphan = parseViewSpec(": orphan");
  assert.ok("error" in orphan);
});

test("sort parses a bare prop as ascending and honors :desc, either case", () => {
  assert.deepEqual(parseViewSpec("sort: released"), { sort: { key: "released", dir: 1 } });
  assert.deepEqual(parseViewSpec("sort: released:desc"), { sort: { key: "released", dir: -1 } });
  assert.deepEqual(parseViewSpec("sort: released:DESC"), { sort: { key: "released", dir: -1 } });
  assert.deepEqual(parseViewSpec("sort: released:asc"), { sort: { key: "released", dir: 1 } });
  // a prop whose own name has spaces survives; the direction is the last segment
  assert.deepEqual(parseViewSpec("sort: cat#:desc"), { sort: { key: "cat#", dir: -1 } });
});

test("a sort direction with no property is malformed", () => {
  const r = parseViewSpec("sort: :desc");
  assert.ok("error" in r);
  assert.match(r.error, /Malformed sort/);
});

test("limit takes a positive whole number and nothing else", () => {
  assert.deepEqual(parseViewSpec("limit: 5"), { limit: 5 });
  for (const bad of ["five", "-3", "2.5", "0", "5 rows"]) {
    const r = parseViewSpec(`limit: ${bad}`);
    assert.ok("error" in r, `expected “${bad}” to be an error`);
    assert.match(r.error, /Malformed limit/);
  }
  const unsafe = parseViewSpec(`limit: ${Number.MAX_SAFE_INTEGER + 1}`);
  assert.ok("error" in unsafe);
});

test("columns splits on commas and trims; an all-commas list is malformed", () => {
  assert.deepEqual(parseViewSpec("columns:  status ,artist  "), {
    columns: ["status", "artist"],
  });
  const r = parseViewSpec("columns: , ,");
  assert.ok("error" in r);
  assert.match(r.error, /Malformed columns/);
});

test("empty option values are malformed, while selector values stay draftable", () => {
  for (const key of ["sort", "limit", "columns"]) {
    const r = parseViewSpec(`type: release\n${key}:`);
    assert.ok("error" in r);
    assert.match(r.error, new RegExp(`Malformed ${key}`));
  }
  assert.deepEqual(parseViewSpec("type: release\nquery:\nsaved:"), { type: "release" });
});

test("values are trimmed; empty values drop the key", () => {
  assert.deepEqual(parseViewSpec("type:   release  \nquery:\nsaved:  "), {
    type: "release",
  });
});

/* ---------- findSavedView ---------- */

test("saved view resolves by id and by name, case-insensitive", () => {
  assert.equal(findSavedView(SAVED, "unreleased")?.db, "release");
  assert.equal(findSavedView(SAVED, "Unreleased")?.id, "unreleased");
  assert.equal(findSavedView(SAVED, "UNRELEASED")?.id, "unreleased");
  assert.equal(findSavedView(SAVED, "nope"), undefined);
});

/* ---------- embedQueryFor ---------- */

test("type + query filters rows and shapes cells along the columns", () => {
  const r = embedQueryFor({ type: "release", query: "status:mastering" }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.dbType, "release");
  assert.deepEqual(r.columns, ["status", "cat#", "artist"]);
  assert.equal(r.total, 1);
  assert.deepEqual(
    r.rows.map(({ path, title, cells }) => ({ path, title, cells })),
    [
      {
        path: "Vessel Songs.md",
        title: "Vessel Songs",
        cells: ["mastering", "SMP-029", "1k petals"],
      },
    ]
  );
  // the widget edits cells, so it needs each row's raw props and the type's
  // schema alongside the display strings
  assert.equal(r.rows[0].props.status, "mastering");
  assert.deepEqual(r.typeSchema, SCHEMA.release);
  assert.equal(r.query, "status:mastering");
});

test("no query lists every note of the type; missing props read as empty cells", () => {
  const r = embedQueryFor({ type: "release" }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.total, 3);
  // schema ∪ note props, COLUMN_ORDER leaders first — capped at EMBED_MAX_COLS
  assert.deepEqual(r.columns, ["status", "cat#", "artist"].slice(0, EMBED_MAX_COLS));
});

test("bare words in the query match titles, like the database filter bar", () => {
  const r = embedQueryFor({ type: "release", query: "vessel" }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.deepEqual(r.rows.map((row) => row.title), ["Vessel Songs"]);
});

test("columns cap at EMBED_MAX_COLS", () => {
  const wide = [
    note("A", { type: "release", status: "live", "cat#": "X-1", artist: "a", category: "lp", created: "2026-01-01" }),
  ];
  const r = embedQueryFor({ type: "release" }, wide, {}, []);
  assert.ok(!("error" in r));
  assert.equal(r.columns.length, EMBED_MAX_COLS);
  assert.deepEqual(r.columns, ["status", "cat#", "artist", "category"]);
  // cells stay aligned with the capped columns
  assert.deepEqual(r.rows[0].cells, ["live", "X-1", "a", "lp"]);
});

test("cells run through displayValue: dates human, embeds/files by basename (SUB-179)", () => {
  const notes = [
    note("Vessel Songs", {
      type: "release",
      released: "2026-07-17",
      artwork: "![[covers/vessel.png]]",
      contract: "~/Documents/contracts/vessel.pdf",
      created: "2026-07-01",
    }),
  ];
  const schema: SchemaConfig = {
    release: {
      released: { options: [], kind: "date" },
      artwork: { options: [] },
      contract: { options: [], kind: "file" },
    },
  };
  const r = embedQueryFor({ type: "release" }, notes, schema, []);
  assert.ok(!("error" in r));
  const cell = (c: string) => r.rows[0].cells[r.columns.indexOf(c)];
  assert.equal(cell("released"), "Jul 17, 2026");
  assert.equal(cell("artwork"), "vessel.png");
  assert.equal(cell("contract"), "vessel.pdf");
  // created is date-kind by default, like the database table
  if (r.columns.includes("created")) assert.equal(cell("created"), "Jul 1, 2026");
});

test("mis-cased fence, note types, and prop keys still include and format rows (SUB-728)", () => {
  // schema keyed `Release`/`Released`, the fence says `type: release` — both
  // hand-authored. Note types and keys are hand-authored too, and two rows
  // can disagree without either disappearing or rendering a blank cell.
  const schema: SchemaConfig = {
    Release: {
      Released: { options: [], kind: "date" },
      Contract: { options: [], kind: "file" },
    },
  };
  const notes = [
    note("Vessel Songs", {
      type: "RELEASE",
      released: "2026-07-17",
      contract: "~/Documents/contracts/vessel.pdf",
    }),
    note("Static Bouquet", {
      Type: "Release",
      RELEASED: "2026-07-18",
      CONTRACT: "~/Documents/contracts/static.pdf",
    }),
  ];
  const r = embedQueryFor({ type: "release" }, notes, schema, []);
  assert.ok(!("error" in r));
  assert.equal(r.total, 2);
  const cell = (row: number, c: string) => r.rows[row].cells[r.columns.indexOf(c)];
  assert.equal(cell(0, "released"), "Jul 17, 2026");
  assert.equal(cell(0, "contract"), "vessel.pdf");
  assert.equal(cell(1, "released"), "Jul 18, 2026");
  assert.equal(cell(1, "contract"), "static.pdf");
});

test("mis-cased created/updated columns keep built-in date formatting", () => {
  const notes = [
    note("Upper", { Type: "Release", Created: "2026-08-01", UPDATED: "2026-08-02" }),
  ];
  const r = embedQueryFor({ type: "release" }, notes, {}, []);
  assert.ok(!("error" in r));
  assert.deepEqual(r.columns, ["Created", "UPDATED"]);
  assert.deepEqual(r.rows[0].cells, ["Aug 1, 2026", "Aug 2, 2026"]);
});

test("a mis-cased schema-only database is not an unknown-database error (SUB-696)", () => {
  const r = embedQueryFor({ type: "RELEASE" }, [], SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.total, 0);
  assert.deepEqual(r.columns, ["status"]);
});

test("rows cap at EMBED_MAX_ROWS with total holding the full count", () => {
  const many = Array.from({ length: EMBED_MAX_ROWS + 10 }, (_, i) =>
    note(`R${i}`, { type: "release", status: "live" })
  );
  const r = embedQueryFor({ type: "release" }, many, {}, []);
  assert.ok(!("error" in r));
  assert.equal(r.rows.length, EMBED_MAX_ROWS);
  assert.equal(r.total, EMBED_MAX_ROWS + 10);
});

test("saved form resolves db + query from the pin", () => {
  const r = embedQueryFor({ saved: "unreleased" }, RELEASES, SCHEMA, SAVED);
  assert.ok(!("error" in r));
  assert.equal(r.dbType, "release");
  assert.deepEqual(r.rows.map((row) => row.title), ["Vessel Songs"]);
});

test("saved form carries the pin's identity for the widget (SUB-211)", () => {
  const r = embedQueryFor({ saved: "unreleased" }, RELEASES, SCHEMA, SAVED);
  assert.ok(!("error" in r));
  assert.equal(r.savedId, "unreleased");
  assert.equal(r.savedName, "Unreleased");
});

test("saved form honors the pin's curated columns, in the pin's order (SUB-212)", () => {
  const pins: SavedView[] = [
    { id: "curated", name: "Curated", db: "release", columns: ["artist", "status"] },
  ];
  const r = embedQueryFor({ saved: "curated" }, RELEASES, SCHEMA, pins);
  assert.ok(!("error" in r));
  assert.deepEqual(r.columns, ["artist", "status"]);
  // cells stay aligned 1:1 with the curated column order
  assert.deepEqual(r.rows[0].cells, ["various", "in review"]);
});

test("saved columns resolve case-insensitively without broadening the pin (SUB-728)", () => {
  const notes = [note("Vessel", { type: "Release", RELEASED: "2026-08-01", CONTRACT: "~/vessel.pdf" })];
  const schema: SchemaConfig = {
    Release: {
      Released: { options: [], kind: "date" },
      Contract: { options: [], kind: "file" },
    },
  };
  const pins: SavedView[] = [
    { id: "dated", name: "Dated", db: "release", columns: ["Released"] },
  ];
  const r = embedQueryFor({ saved: "dated" }, notes, schema, pins);
  assert.ok(!("error" in r));
  assert.deepEqual(r.columns, ["RELEASED"]);
  assert.deepEqual(r.rows[0].cells, ["Aug 1, 2026"]);
});

test("saved form: pin columns ignore unknown keys and cap at EMBED_MAX_COLS (SUB-212)", () => {
  const wide = [
    note("A", { type: "release", status: "live", "cat#": "X-1", artist: "a", category: "lp", created: "2026-01-01" }),
  ];
  const pins: SavedView[] = [
    { id: "wide", name: "Wide", db: "release", columns: ["bogus", "artist", "cat#", "status", "category", "created"] },
  ];
  const r = embedQueryFor({ saved: "wide" }, wide, {}, pins);
  assert.ok(!("error" in r));
  // "bogus" dropped; the remaining five cap at four, keeping the pin's order
  assert.deepEqual(r.columns, ["artist", "cat#", "status", "category"]);
  assert.deepEqual(r.rows[0].cells, ["a", "X-1", "live", "lp"]);
});

test("saved form without columns keeps the capped union (SUB-212)", () => {
  const r = embedQueryFor({ saved: "unreleased" }, RELEASES, SCHEMA, SAVED);
  assert.ok(!("error" in r));
  assert.deepEqual(r.columns, ["status", "cat#", "artist"].slice(0, EMBED_MAX_COLS));
});

test("type form leaves the saved identity unset", () => {
  const r = embedQueryFor({ type: "release" }, RELEASES, SCHEMA, SAVED);
  assert.ok(!("error" in r));
  assert.equal(r.savedId, undefined);
  assert.equal(r.savedName, undefined);
});

test("unknown database → quiet error card", () => {
  assert.deepEqual(embedQueryFor({ type: "bogus" }, RELEASES, SCHEMA, []), {
    error: "Unknown database “bogus”",
  });
});

test("unknown saved id → quiet error card", () => {
  assert.deepEqual(embedQueryFor({ saved: "nope" }, RELEASES, SCHEMA, SAVED), {
    error: "Unknown saved view “nope”",
  });
});

test("empty spec → quiet error card", () => {
  const r = embedQueryFor({}, RELEASES, SCHEMA, []);
  assert.ok("error" in r);
});

/* ---------- sort / limit / columns ---------- */

test("sort orders rows ascending and descending by a plain column", () => {
  const asc = embedQueryFor({ type: "release", sort: { key: "cat#", dir: 1 } }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in asc));
  assert.deepEqual(asc.rows.map((r) => r.title), ["Static Bouquet", "Vessel Songs", "Slow Bloom EP"]);
  const desc = embedQueryFor({ type: "release", sort: { key: "cat#", dir: -1 } }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in desc));
  assert.deepEqual(desc.rows.map((r) => r.title), ["Slow Bloom EP", "Vessel Songs", "Static Bouquet"]);
});

test("sort is the database table's comparator, not a second one (SUB-309 select order)", () => {
  // `status` is a schema select whose only declared option is "live" — the
  // table orders declared options first, so this must NOT be alphabetical
  const r = embedQueryFor({ type: "release", sort: { key: "status", dir: 1 } }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.deepEqual(r.rows.map((row) => row.title), [
    "Static Bouquet", // live: the one declared option
    "Slow Bloom EP", // "in review" / "mastering" collate among themselves
    "Vessel Songs",
  ]);
});

test("sort resolves the property case-insensitively, and title without being a column", () => {
  const byProp = embedQueryFor({ type: "release", sort: { key: "CAT#", dir: 1 } }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in byProp));
  assert.deepEqual(byProp.rows.map((r) => r.title), ["Static Bouquet", "Vessel Songs", "Slow Bloom EP"]);
  const byTitle = embedQueryFor({ type: "release", sort: { key: "Title", dir: -1 } }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in byTitle));
  assert.deepEqual(byTitle.rows.map((r) => r.title), ["Vessel Songs", "Static Bouquet", "Slow Bloom EP"]);
});

test("an unknown sort property is a quiet error, not an unsorted table", () => {
  assert.deepEqual(embedQueryFor({ type: "release", sort: { key: "bogus", dir: 1 } }, RELEASES, SCHEMA, []), {
    error: "Unknown sort property “bogus” in “release”",
  });
});

test("limit cuts AFTER the sort, so sort+limit means “the top N”", () => {
  const r = embedQueryFor(
    { type: "release", sort: { key: "cat#", dir: -1 }, limit: 2 },
    RELEASES,
    SCHEMA,
    []
  );
  assert.ok(!("error" in r));
  assert.deepEqual(r.rows.map((row) => row.title), ["Slow Bloom EP", "Vessel Songs"]);
});

test("limit cuts AFTER filtering, and total keeps the full match count", () => {
  const r = embedQueryFor({ type: "release", query: "status:mastering,live", limit: 1 }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.rows.length, 1);
  assert.equal(r.total, 2); // two matched; one is shown
});

test("cut names the author's limit, so the row-count line can say so (SUB-942)", () => {
  const r = embedQueryFor({ type: "release", limit: 2 }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.deepEqual(r.cut, { kind: "limit", shown: 2 });
  assert.equal(r.total, 3);
});

test("a limit no smaller than the result set cuts nothing", () => {
  const exact = embedQueryFor({ type: "release", limit: 3 }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in exact));
  assert.equal(exact.cut, undefined);
  const roomy = embedQueryFor({ type: "release", limit: 99 }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in roomy));
  assert.equal(roomy.cut, undefined);
  assert.equal(roomy.rows.length, 3);
});

test("the surface cap is a different fact from the author's limit", () => {
  const many = Array.from({ length: EMBED_MAX_ROWS + 10 }, (_, i) =>
    note(`R${i}`, { type: "release", status: "live" })
  );
  // no limit: the cap fired, and the wording must not blame the author
  const capped = embedQueryFor({ type: "release" }, many, {}, []);
  assert.ok(!("error" in capped));
  assert.deepEqual(capped.cut, { kind: "cap", shown: EMBED_MAX_ROWS });
  // a limit ABOVE the cap can't be honored — the cap is what actually cut
  const over = embedQueryFor({ type: "release", limit: EMBED_MAX_ROWS + 5 }, many, {}, []);
  assert.ok(!("error" in over));
  assert.deepEqual(over.cut, { kind: "cap", shown: EMBED_MAX_ROWS });
  assert.equal(over.rows.length, EMBED_MAX_ROWS);
  // a tighter limit is the one the reader sees, so it owns the message
  const under = embedQueryFor({ type: "release", limit: 5 }, many, {}, []);
  assert.ok(!("error" in under));
  assert.deepEqual(under.cut, { kind: "limit", shown: 5 });
  assert.equal(under.total, EMBED_MAX_ROWS + 10);
});

test("a wider surface honors a limit the inline cap would have swallowed", () => {
  const many = Array.from({ length: EMBED_MAX_ROWS + 10 }, (_, i) =>
    note(`R${i}`, { type: "release", status: "live" })
  );
  const r = embedQueryFor({ type: "release", limit: EMBED_MAX_ROWS + 5 }, many, {}, [], {
    cols: 8,
    rows: 200,
  });
  assert.ok(!("error" in r));
  assert.deepEqual(r.cut, { kind: "limit", shown: EMBED_MAX_ROWS + 5 });
});

test("columns accept the fixed Title leader, then pick properties case-insensitively", () => {
  const r = embedQueryFor(
    { type: "release", columns: ["Title", "ARTIST", "title", "Status"] },
    RELEASES,
    SCHEMA,
    []
  );
  assert.ok(!("error" in r));
  // Title stays on every row and outside the optional-property projection;
  // listing it twice neither duplicates it nor consumes a column slot.
  assert.equal(r.rows[0].title, "Slow Bloom EP");
  assert.deepEqual(r.columns, ["artist", "status"]);
  // cells follow the requested order 1:1
  assert.deepEqual(r.rows[0].cells, ["various", "in review"]);
});

test("a column listed twice is one column, kept at its first position", () => {
  const r = embedQueryFor({ type: "release", columns: ["status", "artist", "STATUS"] }, RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.deepEqual(r.columns, ["status", "artist"]);
});

test("an unknown column in a fence is an error — unlike a pin's stale list", () => {
  assert.deepEqual(embedQueryFor({ type: "release", columns: ["artist", "bogus"] }, RELEASES, SCHEMA, []), {
    error: "Unknown column “bogus” in “release”",
  });
});

test("an explicit columns list is still bounded by the surface's column cap", () => {
  const wide = [
    note("A", { type: "release", status: "live", "cat#": "X-1", artist: "a", category: "lp", created: "2026-01-01" }),
  ];
  const r = embedQueryFor(
    { type: "release", columns: ["created", "category", "artist", "cat#", "status"] },
    wide,
    {},
    []
  );
  assert.ok(!("error" in r));
  assert.equal(r.columns.length, EMBED_MAX_COLS);
  assert.deepEqual(r.columns, ["created", "category", "artist", "cat#"]);
  assert.deepEqual(r.rows[0].cells, ["Jan 1, 2026", "lp", "a", "X-1"]);
});

test("a fence's own columns/sort/limit apply over a saved pin", () => {
  const pins: SavedView[] = [
    { id: "curated", name: "Curated", db: "release", columns: ["artist", "status"] },
  ];
  const r = embedQueryFor(
    { saved: "curated", columns: ["cat#"], sort: { key: "cat#", dir: 1 }, limit: 2 },
    RELEASES,
    SCHEMA,
    pins
  );
  assert.ok(!("error" in r));
  // the fence's list wins over the pin's curated one
  assert.deepEqual(r.columns, ["cat#"]);
  assert.deepEqual(r.rows.map((row) => row.title), ["Static Bouquet", "Vessel Songs"]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.cut, { kind: "limit", shown: 2 });
  // the pin's identity survives the fence's extra keys
  assert.equal(r.savedId, "curated");
});

test("a fence sort composes with the pin's own query", () => {
  const r = embedQueryFor({ saved: "unreleased", sort: { key: "cat#", dir: -1 } }, RELEASES, SCHEMA, SAVED);
  assert.ok(!("error" in r));
  assert.deepEqual(r.rows.map((row) => row.title), ["Vessel Songs"]);
  assert.equal(r.query, "status:mastering");
});

test("a saved embed keeps the pin's multi-key sort unless the fence overrides it", () => {
  const pins: SavedView[] = [
    {
      id: "ordered",
      name: "Ordered",
      db: "release",
      sorts: [
        { key: "status", dir: 1 },
        { key: "cat#", dir: -1 },
      ],
    },
  ];
  const inherited = embedQueryFor({ saved: "ordered" }, RELEASES, SCHEMA, pins);
  assert.ok(!("error" in inherited));
  assert.deepEqual(inherited.rows.map((row) => row.title), ["Static Bouquet", "Slow Bloom EP", "Vessel Songs"]);

  const overridden = embedQueryFor(
    { saved: "ordered", sort: { key: "title", dir: 1 } },
    RELEASES,
    SCHEMA,
    pins
  );
  assert.ok(!("error" in overridden));
  assert.deepEqual(overridden.rows.map((row) => row.title), ["Slow Bloom EP", "Static Bouquet", "Vessel Songs"]);
});

test("a parse error travels through as the render path's own error", () => {
  assert.deepEqual(
    embedQueryFor(parseViewSpec("type: release\nsortt: status"), RELEASES, SCHEMA, []),
    { error: "Unknown key “sortt” — try type, query, saved, view, sort, limit, columns" }
  );
});

test("a plain fence without the new keys is unchanged (regression)", () => {
  const r = embedQueryFor(parseViewSpec("type: release\nview: table"), RELEASES, SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.cut, undefined);
  assert.equal(r.total, 3);
  assert.deepEqual(r.rows.map((row) => row.title), RELEASES.map((n) => n.title));
});

test("a schema-only database renders with zero rows (not an error)", () => {
  const r = embedQueryFor({ type: "release" }, [], SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.total, 0);
  assert.deepEqual(r.columns, ["status"]);
  assert.deepEqual(r.rows, []);
});

/* ---------- seedPropsFromQuery ---------- */

test("plain key:value equality terms seed a new row", () => {
  assert.deepEqual(seedPropsFromQuery("status:mastering"), [["status", "mastering"]]);
  assert.deepEqual(seedPropsFromQuery("status:mastering artist:umbra"), [
    ["status", "mastering"],
    ["artist", "umbra"],
  ]);
});

test("an empty or whitespace query seeds nothing", () => {
  assert.deepEqual(seedPropsFromQuery(""), []);
  assert.deepEqual(seedPropsFromQuery("   "), []);
});

test("negations never seed — no single value satisfies them", () => {
  assert.deepEqual(seedPropsFromQuery("-status:live"), []);
  assert.deepEqual(seedPropsFromQuery("-status:live artist:umbra"), [["artist", "umbra"]]);
});

test("comparisons never seed — a range has no one value", () => {
  assert.deepEqual(seedPropsFromQuery("due < 7d"), []);
  assert.deepEqual(seedPropsFromQuery("due<2026-01-01 status:live"), [["status", "live"]]);
});

test("OR-lists never seed — picking one member would be a guess", () => {
  assert.deepEqual(seedPropsFromQuery("status:live,mastering"), []);
  assert.deepEqual(seedPropsFromQuery("status:live,mastering artist:umbra"), [
    ["artist", "umbra"],
  ]);
});

test("bare words and quoted phrases match text, not a prop — they never seed", () => {
  assert.deepEqual(seedPropsFromQuery("bloom"), []);
  assert.deepEqual(seedPropsFromQuery('"night drive" status:live'), [["status", "live"]]);
});

test("system props stay the caller's — type/title/created never seed", () => {
  assert.deepEqual(seedPropsFromQuery("type:release status:live"), [["status", "live"]]);
  assert.deepEqual(seedPropsFromQuery("title:foo created:2026-01-01"), []);
});

test("a repeated key keeps the first term, like a filter-born entry", () => {
  // the database pane's own rule (filterInherits) — the fence seed
  // delegates to it rather than holding a second opinion
  assert.deepEqual(seedPropsFromQuery("status:live status:mastering"), [["status", "live"]]);
});

test("the schema's spelling wins for both key and option value", () => {
  const schema = { Status: { options: [{ value: "Mastering" }, { value: "Live" }] } };
  assert.deepEqual(seedPropsFromQuery("status:mastering", schema), [["Status", "Mastering"]]);
  // a value the schema doesn't declare keeps what was typed (lowercased by the parse)
  assert.deepEqual(seedPropsFromQuery("status:archived", schema), [["Status", "archived"]]);
});

test("a key the schema doesn't declare still seeds, as typed", () => {
  assert.deepEqual(seedPropsFromQuery("artist:umbra", { status: { options: [] } }), [
    ["artist", "umbra"],
  ]);
});
