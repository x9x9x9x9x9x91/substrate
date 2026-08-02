import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_MAX_COLS,
  EMBED_MAX_ROWS,
  embedQueryFor,
  findSavedView,
  parseViewSpec,
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

test("unknown keys and malformed lines are ignored", () => {
  assert.deepEqual(
    parseViewSpec("type: release\ncolumns: status, artist\nnot a kv line\n\n# comment\n: orphan"),
    { type: "release" }
  );
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
  assert.deepEqual(r, {
    dbType: "release",
    columns: ["status", "cat#", "artist"],
    total: 1,
    rows: [
      {
        path: "Vessel Songs.md",
        title: "Vessel Songs",
        cells: ["mastering", "SMP-029", "1k petals"],
      },
    ],
  });
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
  // created is date-kind by default, like the database table (SUB-167)
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

test("a schema-only database renders with zero rows (not an error)", () => {
  const r = embedQueryFor({ type: "release" }, [], SCHEMA, []);
  assert.ok(!("error" in r));
  assert.equal(r.total, 0);
  assert.deepEqual(r.columns, ["status"]);
  assert.deepEqual(r.rows, []);
});
