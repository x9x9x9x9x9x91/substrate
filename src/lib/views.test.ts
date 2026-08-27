import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, PropSchema, SavedView } from "./types.ts";
import {
  filterByQuery,
  findViewByName,
  isPristineScratch,
  isScratchNote,
  isVoiceNote,
  newViewId,
  partitionDbEntries,
  pinsInSidebarOrder,
  saveViewHint,
  scratchNotes,
} from "./views.ts";
import { shiftDate, todayIso } from "./dates.ts";

function note(title: string, props: Record<string, unknown> = {}): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props,
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const releases: NoteMeta[] = [
  note("Slow Bloom EP", { type: "release", status: "in review", artist: "various" }),
  note("Static Bouquet", { type: "release", status: "live", artist: "chroma weather" }),
  note("Glass Havens", { type: "release", status: "live", artist: "fern palace" }),
];

test("filterByQuery: empty query returns the input untouched", () => {
  assert.equal(filterByQuery(releases, ""), releases);
  assert.equal(filterByQuery(releases, "   "), releases);
});

test("filterByQuery: prop filter matches exact and prefix, case-insensitive", () => {
  assert.deepEqual(
    filterByQuery(releases, "status:live").map((n) => n.title),
    ["Static Bouquet", "Glass Havens"]
  );
  // prefix matching: `in` hits "in review" (query.ts valueMatches semantics)
  assert.deepEqual(
    filterByQuery(releases, "STATUS:in").map((n) => n.title),
    ["Slow Bloom EP"]
  );
});

test("filterByQuery: quoted values keep spaces together", () => {
  assert.deepEqual(
    filterByQuery(releases, 'status:"in review"').map((n) => n.title),
    ["Slow Bloom EP"]
  );
});

test("filterByQuery: a comma-separated value is an OR over one prop (SUB-78)", () => {
  // the union of both statuses = every release
  assert.deepEqual(
    filterByQuery(releases, 'status:live,"in review"').map((n) => n.title),
    ["Slow Bloom EP", "Static Bouquet", "Glass Havens"]
  );
  // still typing: the partial segment narrows on top of the committed one
  assert.deepEqual(
    filterByQuery(releases, "status:live,in").map((n) => n.title),
    ["Slow Bloom EP", "Static Bouquet", "Glass Havens"]
  );
  // one committed segment alone narrows while the comma dangles
  assert.deepEqual(
    filterByQuery(releases, "status:live,").map((n) => n.title),
    ["Static Bouquet", "Glass Havens"]
  );
});

test("filterByQuery: bare words match the title, all words must hit", () => {
  assert.deepEqual(
    filterByQuery(releases, "bouquet").map((n) => n.title),
    ["Static Bouquet"]
  );
  assert.deepEqual(
    filterByQuery(releases, "slow bloom").map((n) => n.title),
    ["Slow Bloom EP"]
  );
  assert.deepEqual(filterByQuery(releases, "slow bouquet"), []);
});

test("filterByQuery: a quoted phrase matches as one substring (SUB-232)", () => {
  const notes = [
    note("Night Drive", { type: "release" }),
    note("night owl drive", { type: "release" }),
    note("drive", { type: "release" }),
  ];
  // the phrase hits only titles containing it verbatim (case-insensitive)…
  assert.deepEqual(
    filterByQuery(notes, '"night drive"').map((n) => n.title),
    ["Night Drive"]
  );
  // …while the same words unquoted keep the every-word semantics
  assert.deepEqual(
    filterByQuery(notes, "night drive").map((n) => n.title),
    ["Night Drive", "night owl drive"]
  );
  // a phrase combines with operators like any word
  assert.deepEqual(
    filterByQuery(releases, 'status:live "glass havens"').map((n) => n.title),
    ["Glass Havens"]
  );
});

test("filterByQuery: words and operators combine", () => {
  assert.deepEqual(
    filterByQuery(releases, "status:live glass").map((n) => n.title),
    ["Glass Havens"]
  );
});

test("filterByQuery: a half-typed trailing operator already narrows", () => {
  assert.deepEqual(
    filterByQuery(releases, "status:li").map((n) => n.title),
    ["Static Bouquet", "Glass Havens"]
  );
  // bare `status:` (no partial yet) narrows nothing
  assert.equal(filterByQuery(releases, "status:").length, 3);
});

test("filterByQuery: date comparisons, committed and half-typed (SUB-66)", () => {
  // built relative to the real today, so the assertions hold on any run date
  const tasks = [
    note("Overdue", { type: "task", due: shiftDate(todayIso(), -2) }),
    note("Soon", { type: "task", due: shiftDate(todayIso(), 2) }),
    note("Later", { type: "task", due: shiftDate(todayIso(), 9) }),
  ];
  const names = (q: string) => filterByQuery(tasks, q).map((n) => n.title);
  // committed with a trailing space: earlier than today+7d, overdue included
  assert.deepEqual(names("due < 7d "), ["Overdue", "Soon"]);
  // still being typed (no trailing space): narrows live through the trailing op
  assert.deepEqual(names("due < 7d"), ["Overdue", "Soon"]);
  // absolute operand
  assert.deepEqual(names(`due >= ${todayIso()} `), ["Soon", "Later"]);
  // half-typed operand (`due < 7`) is inert — the list stays put
  assert.deepEqual(names("due < 7"), ["Overdue", "Soon", "Later"]);
});

const pins: SavedView[] = [
  { id: "live", name: "Live", db: "release" },
  { id: "live-2", name: "Live", db: "gear" },
];

test("findViewByName matches case-insensitively within the same db only", () => {
  assert.equal(findViewByName(pins, "release", "live")?.id, "live");
  assert.equal(findViewByName(pins, "release", "  LIVE ")?.id, "live");
  assert.equal(findViewByName(pins, "RELEASE", "live")?.id, "live");
  assert.equal(findViewByName(pins, "gear", "live")?.id, "live-2");
  assert.equal(findViewByName(pins, "task", "live"), undefined);
  assert.equal(findViewByName(pins, "release", "other"), undefined);
});

test("saveViewHint names the pin a same-name save would replace", () => {
  // saving upserts by name, so this press REPLACES the pin — and the field
  // opens seeded with the open pin's name, making that the common press
  assert.equal(saveViewHint(pins, "release", "Live"), "Updates “Live”");
  assert.equal(saveViewHint(pins, "release", " Live "), "Updates “Live”");
  // matching folds case but the save stores the name as typed, so a
  // differently-spelled match RENAMES the pin too — both spellings show
  assert.equal(saveViewHint(pins, "release", " live "), "Updates “Live” → “live”");
  assert.equal(saveViewHint(pins, "release", "LIVE"), "Updates “Live” → “LIVE”");
  // a name of another database's pin is a new pin here
  assert.equal(saveViewHint(pins, "task", "Live"), null);
  assert.equal(saveViewHint(pins, "release", "Live 2"), null);
  assert.equal(saveViewHint(pins, "release", ""), null);
});

test("newViewId slugifies and dedupes with a numeric suffix", () => {
  assert.equal(newViewId("Live", pins), "live-3");
  assert.equal(newViewId("Releases — in review!", pins), "releases-in-review");
  assert.equal(newViewId("  ", pins), "view");
  assert.equal(newViewId("Live", []), "live");
});

test("pinsInSidebarOrder: databases first, array order within each (SUB-67)", () => {
  const many: SavedView[] = [
    { id: "g1", name: "G1", db: "gear" },
    { id: "r1", name: "R1", db: "release" },
    { id: "g2", name: "G2", db: "gear" },
    { id: "t1", name: "T1", db: "task" },
    { id: "r2", name: "R2", db: "release" },
  ];
  assert.deepEqual(
    pinsInSidebarOrder(many, ["release", "gear"]).map((v) => v.id),
    ["r1", "r2", "g1", "g2"],
    "pins group under their database in sidebar order"
  );
  assert.deepEqual(
    pinsInSidebarOrder(many, ["gear", "release", "task"]).map((v) => v.id),
    ["g1", "g2", "r1", "r2", "t1"]
  );
  // a pin whose database isn't listed doesn't render, so it gets no shortcut
  assert.deepEqual(
    pinsInSidebarOrder(many, ["release"]).map((v) => v.id),
    ["r1", "r2"]
  );
  assert.deepEqual(pinsInSidebarOrder([], ["release"]), []);
  assert.deepEqual(
    pinsInSidebarOrder([{ id: "mixed", name: "Mixed", db: "Release" }], ["release"]).map(
      (v) => v.id
    ),
    ["mixed"]
  );
});

test("isScratchNote: only notes without a type prop are scratch (SUB-70)", () => {
  assert.ok(isScratchNote(note("Quick thought")));
  assert.ok(isScratchNote(note("Empty type", { type: "" })), "empty type counts as untyped");
  assert.ok(!isScratchNote(note("Slow Bloom EP", { type: "release" })));
  assert.ok(!isScratchNote(note("Hand-edited task", { Type: "task" })));
  assert.ok(!isScratchNote(note("Overview", { type: "dashboard" })));
  assert.ok(!isScratchNote(note("Stub", { type: "finance-doc" })));
});

test("isScratchNote: filing into a folder promotes out of Notes (SUB-390)", () => {
  const inFolder = (folder: string, props: Record<string, unknown> = {}) => ({
    ...note("Filed", props),
    folder,
  });
  assert.ok(isScratchNote(inFolder("")), "root stays scratch");
  assert.ok(isScratchNote(inFolder("Inbox")), "Inbox is the capture landing zone");
  assert.ok(isScratchNote(inFolder("Inbox/Later")), "Inbox subfolders count too");
  assert.ok(!isScratchNote(inFolder("Journal")), "a filed daily belongs to its folder");
  assert.ok(!isScratchNote(inFolder("Life/Recipes")));
  assert.ok(!isScratchNote(inFolder("Inboxes")), "prefix must be a path segment");
  assert.ok(!isScratchNote(inFolder("Projects", { type: "release" })), "typed stays out either way");
});

test("isScratchNote: unfiled voice captures stay in the Scratch stream (SUB-827)", () => {
  const voice = (folder: string, props: Record<string, unknown> = { type: "voice" }) => ({
    ...note("Voice 2026-08-04 14.32", props),
    folder,
  });
  assert.ok(isScratchNote(voice("Inbox")), "a hotkey capture lands in Inbox and shows in Notes");
  assert.ok(isScratchNote(voice("")), "root counts like any other capture");
  assert.ok(isScratchNote(voice("Inbox/Later")));
  assert.ok(isScratchNote(voice("Inbox", { Type: "Voice" })), "type read is case-folded");
  assert.ok(!isScratchNote(voice("Journal")), "filing a voice note promotes it out of Notes");
  assert.ok(!isScratchNote(voice("Inbox", { type: "release" })), "other types are unaffected");
});

test("isVoiceNote: the `voice` type, case-folded, filed or not (SUB-827)", () => {
  assert.ok(isVoiceNote(note("V", { type: "voice" })));
  assert.ok(isVoiceNote(note("V", { Type: " Voice " })));
  assert.ok(!isVoiceNote(note("V", { type: "release" })));
  assert.ok(!isVoiceNote(note("V")));
});

test("scratchNotes: untyped only, newest edit first", () => {
  const mix = [
    { ...note("Old scratch"), updated_ms: 10 },
    { ...note("A release", { type: "release" }), updated_ms: 30 },
    { ...note("New scratch"), updated_ms: 20 },
    { ...note("A dashboard", { type: "dashboard" }), updated_ms: 40 },
  ];
  assert.deepEqual(
    scratchNotes(mix).map((n) => n.title),
    ["New scratch", "Old scratch"]
  );
});

test("partitionDbEntries: notes of used types collapse, the rest stays loose (SUB-87)", () => {
  const mix = [
    note("Slow Bloom EP", { type: "release" }),
    note("Master v3", { type: "TASK" }),
    note("Dune", { type: "book" }), // typed, but not a used database type → loose
    note("Welcome"), // untyped → loose
    note("Empty type", { type: "" }), // empty type counts as untyped → loose
  ];
  const { loose, blocks } = partitionDbEntries(mix, new Set(["release", "task"]));
  // loose keeps the input order — the caller's sort survives the partition
  assert.deepEqual(
    loose.map((n) => n.title),
    ["Dune", "Welcome", "Empty type"]
  );
  assert.deepEqual(blocks, [
    { type: "release", count: 1 },
    { type: "task", count: 1 },
  ]);
});

test("partitionDbEntries: membership follows the used-types set, not the schema (SUB-152)", () => {
  // a type with notes but no schema entry is a database (the sidebar lists
  // it) — its notes collapse like any schema'd type's
  const mix = [note("Dune", { type: "book" }), note("Welcome")];
  const { loose, blocks } = partitionDbEntries(mix, new Set(["book"]));
  assert.deepEqual(loose.map((n) => n.title), ["Welcome"]);
  assert.deepEqual(blocks, [{ type: "book", count: 1 }]);
});

test("partitionDbEntries: blocks sort by count desc, then type name", () => {
  const many = [
    note("g1", { type: "gear" }),
    note("t1", { type: "task" }),
    note("r1", { type: "release" }),
    note("t2", { type: "task" }),
    note("r2", { type: "release" }),
  ];
  // release and task tie at 2 → alphabetical within the tie
  assert.deepEqual(partitionDbEntries(many, new Set(["gear", "task", "release"])).blocks, [
    { type: "release", count: 2 },
    { type: "task", count: 2 },
    { type: "gear", count: 1 },
  ]);
});

test("partitionDbEntries: an empty type set collapses nothing", () => {
  const mix = [note("A", { type: "release" }), note("B")];
  const { loose, blocks } = partitionDbEntries(mix, new Set());
  assert.equal(loose.length, 2);
  assert.deepEqual(blocks, []);
});

test("filterByQuery: a quoted phrase is an exact substring, not words (SUB-219)", () => {
  // this once matched nothing — the quote characters stayed on the words
  assert.deepEqual(
    filterByQuery(releases, '"slow bloom"').map((n) => n.title),
    ["Slow Bloom EP"]
  );
  // case-insensitive
  assert.deepEqual(
    filterByQuery(releases, '"STATIC BOUQUET"').map((n) => n.title),
    ["Static Bouquet"]
  );
  // both words present but apart in the title — phrase semantics, not AND
  assert.deepEqual(filterByQuery(releases, '"bloom slow"'), []);
  // phrases combine with filters and bare words
  assert.deepEqual(
    filterByQuery(releases, 'status:live "glass havens"').map((n) => n.title),
    ["Glass Havens"]
  );
  assert.deepEqual(
    filterByQuery(releases, '"in review" static').map((n) => n.title),
    []
  );
});

test("filterByQuery: a phrase hits body excerpt and prop text too (SUB-219)", () => {
  const notes = [
    { ...note("Alpha", { type: "release" }), excerpt: "recorded at funkhaus berlin" },
    note("Beta", { type: "release", studio: "funkhaus berlin" }),
    note("Gamma", { type: "release" }),
  ];
  assert.deepEqual(
    filterByQuery(notes, '"funkhaus berlin"').map((n) => n.title),
    ["Alpha", "Beta"]
  );
  // several phrases must all hit
  assert.deepEqual(
    filterByQuery(notes, '"funkhaus berlin" "beta"').map((n) => n.title),
    ["Beta"]
  );
});

test("filterByQuery: a path- or URI-shaped token is a text word, not a prop filter (SUB-219)", () => {
  const notes = [note("backup of file:///x"), note("mix ~/Music/set.wav"), note("unrelated")];
  // as bogus `file:`/`c:` prop filters these would blank the list entirely
  assert.deepEqual(filterByQuery(notes, "file:///x").map((n) => n.title), ["backup of file:///x"]);
  assert.deepEqual(
    filterByQuery(notes, "~/Music/set.wav").map((n) => n.title),
    ["mix ~/Music/set.wav"]
  );
  assert.deepEqual(
    filterByQuery([note("on C:\\Music\\set.wav"), note("unrelated")], "C:\\Music\\set.wav").map((n) => n.title),
    ["on C:\\Music\\set.wav"]
  );
});

test("filterByQuery: a non-ASCII prop key filters (SUB-219)", () => {
  const notes = [note("a", { gebühr: "12" }), note("b", { gebühr: "99" }), note("c")];
  assert.deepEqual(filterByQuery(notes, "Gebühr:12 ").map((n) => n.title), ["a"]);
  // still-typing narrows through the trailing stub, like any other key
  assert.deepEqual(filterByQuery(notes, "Gebühr:9").map((n) => n.title), ["b"]);
});

test("isPristineScratch: only an untouched ⌘N note qualifies (SUB-264)", () => {
  const created = { created: "2026-07-19" };
  // the canonical fresh scratch note, dedupe suffixes included
  assert.equal(isPristineScratch("Inbox/Untitled.md", "", created), true);
  assert.equal(isPristineScratch("Inbox/Untitled 2.md", "  \n ", created), true);
  assert.equal(isPristineScratch("Projects/Untitled 12.md", "", created), true);
  // any content, a real title, or one extra prop keeps the note
  assert.equal(isPristineScratch("Inbox/Untitled.md", "x", created), false);
  assert.equal(isPristineScratch("Inbox/My idea.md", "", created), false);
  assert.equal(isPristineScratch("Inbox/Untitled.md", "", { ...created, type: "release" }), false);
  assert.equal(isPristineScratch("Inbox/untitled.md", "", created), false);
  // no props at all is still nothing beyond the create defaults
  assert.equal(isPristineScratch("Inbox/Untitled.md", "", {}), true);
});

/* The abandon flow is the predicate's only consumer, and it lives inside
   App.tsx's `useCallback` — nothing exports it, so the ordering it depends on
   is read from the source, the way the CSV picker's defaults are. What is
   guarded here is one-way: the entry guard turns every later leave into a
   no-op for an untracked path, and no other sweep looks for pristine scratch
   notes, so untracking before a delete that fails leaves the note behind for
   good with nothing left to retry it. */
test("a pristine scratch note is untracked only after the delete lands", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const body = /const abandonScratch = useCallback\(([\s\S]*?)\n {2}\);/.exec(app)?.[1] ?? "";
  assert.ok(body, "the abandon callback moved — retarget this test");

  // the pristine branch: everything after the emptiness read
  const branch = body.slice(body.indexOf("isPristineScratch"));
  const deleted = branch.indexOf("await vaultDelete(path)");
  const untracked = branch.indexOf("scratchPaths.current.delete(path)");
  assert.ok(deleted >= 0, "the delete moved — retarget this test");
  assert.ok(untracked >= 0, "the untrack moved — retarget this test");
  assert.ok(deleted < untracked, "the note is untracked before the delete is even attempted");
  assert.doesNotMatch(branch, /vaultDelete\(path\)\.catch/, "a swallowed delete cannot be retried");
});

/* The pane passes its type schema through, so a number column
   filters by value end to end — including the mid-typing stub, which is where
   the old text semantics silently let every row through. */
const priced: NoteMeta[] = [
  note("Rack", { price: "1200.00" }),
  note("Cable", { price: "12" }),
  note("Mic", { price: "120.5" }),
  note("Loan", { price: "tbd" }),
];
const PRICE_SCHEMA: Record<string, PropSchema> = { price: { options: [], kind: "number" } };
const titles = (q: string, s?: Record<string, PropSchema>) =>
  filterByQuery(priced, q, todayIso(), s).map((n) => n.title);

test("filterByQuery: price:1200 hits the 1200.00 cell and nothing else (SUB-639)", () => {
  assert.deepEqual(titles("price:1200 ", PRICE_SCHEMA), ["Rack"]);
  assert.deepEqual(titles("price:12 ", PRICE_SCHEMA), ["Cable"], "no prefix sweep");
});

test("filterByQuery: price > 500 compares by value, mid-typing included (SUB-639)", () => {
  assert.deepEqual(titles("price > 500 ", PRICE_SCHEMA), ["Rack"]);
  assert.deepEqual(titles("price > 500", PRICE_SCHEMA), ["Rack"], "the un-spaced stub narrows too");
  assert.deepEqual(titles("price < 500 ", PRICE_SCHEMA), ["Cable", "Mic"], "not lexicographic");
});

test("filterByQuery: without a schema the classic text semantics stand", () => {
  assert.deepEqual(titles("price:12 "), ["Rack", "Cable", "Mic"], "prefix matching, as before");
});
