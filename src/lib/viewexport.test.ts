import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, PropSchema, SavedView } from "./types.ts";

// viewexport.ts reaches the backend through src/lib/tauri.ts, which picks the
// mock when `window` carries no __TAURI_INTERNALS__ — shim a bare window
// before importing so the module loads under plain node (assets.test.ts
// pattern).
(globalThis as Record<string, unknown>).window = {};

const { savedViewRows, exportFolderName, exportSummary } = await import("./viewexport.ts");

function note(path: string, title: string, props: Record<string, unknown>): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    excerpt: "",
    props,
    updated_ms: 0,
  } as NoteMeta;
}

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: "v1",
  name: "Unfinished",
  db: "Track",
  ...over,
});

test("savedViewRows takes the view's database and applies its own query (SUB-810)", () => {
  const notes = [
    note("Tracks/A.md", "A", { type: "track", status: "unfinished" }),
    note("Tracks/B.md", "B", { type: "track", status: "released" }),
    note("Notes/C.md", "C", { type: "note", status: "unfinished" }),
  ];
  const rows = savedViewRows(notes, view({ query: "status:unfinished" }));
  assert.deepEqual(
    rows.map((n) => n.path),
    ["Tracks/A.md"]
  );
});

test("savedViewRows without a query is the whole database, case-folded", () => {
  const notes = [
    note("Tracks/A.md", "A", { type: "Track" }),
    note("Tracks/B.md", "B", { type: "track" }),
    note("Notes/C.md", "C", {}),
  ];
  assert.equal(savedViewRows(notes, view()).length, 2);
});

test("savedViewRows filters over derived rollup columns (SUB-678), like the pane", () => {
  // a pin whose query reads a rollup column must export the rows the pane
  // shows — rollups are computed on read and stored nowhere
  const schema: Record<string, PropSchema> = {
    entries: { options: [], kind: "relation", type: "ledger" },
    earned: { options: [], kind: "rollup", relation: "entries", prop: "amount", agg: "sum" },
  };
  const notes = [
    note("Ledger/L1.md", "L1", { type: "ledger", amount: "100" }),
    note("Ledger/L2.md", "L2", { type: "ledger", amount: "20" }),
    note("Releases/Big.md", "Big", { type: "release", entries: ["L1", "L2"] }),
    note("Releases/Small.md", "Small", { type: "release", entries: ["L2"] }),
  ];
  // Big's two ledger entries sum to 120, Small's one to 20 — a query on the
  // derived column only matches if the rollup was computed before filtering
  const rows = savedViewRows(notes, view({ db: "release", query: "earned:120" }), schema);
  assert.deepEqual(
    rows.map((n) => n.path),
    ["Releases/Big.md"]
  );
});

test("exportFolderName keeps a pin name filesystem-safe", () => {
  // a slash in a pin name would silently export into a subfolder
  assert.equal(exportFolderName("Mixdowns / Q3"), "Mixdowns - Q3");
  assert.equal(exportFolderName("dark : 128bpm"), "dark - 128bpm");
  assert.equal(exportFolderName("  Live set  "), "Live set");
  assert.equal(exportFolderName(".."), "Substrate view");
  assert.equal(exportFolderName("   "), "Substrate view");
});

test("exportSummary reports skipped rows and untouched files, and stays quiet otherwise", () => {
  assert.equal(
    exportSummary({ dest: "/Users/x/Live/Unfinished", links: 1, missing: 0, kept: 0 }),
    "1 link in Unfinished"
  );
  assert.equal(
    exportSummary({ dest: "/Users/x/Live/Unfinished", links: 12, missing: 2, kept: 1 }),
    "12 links in Unfinished · 2 rows skipped · 1 file of your own left alone"
  );
});
