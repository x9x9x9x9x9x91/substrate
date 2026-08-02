import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, RelatedEntry } from "./types.ts";
import {
  chipCommitValue,
  filterCandidates,
  propList,
  propListValue,
  relationCandidates,
  relatedGroups,
  toggleValue,
} from "./relation.ts";
import { matchesFilters, propValues } from "./query.ts";

function note(path: string, props: Record<string, unknown>, title?: string): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return {
    path,
    stem,
    title: title ?? stem,
    folder: path.includes("/") ? path.split("/").slice(0, -1).join("/") : "",
    props,
    updated_ms: 0,
    excerpt: "",
  };
}

test("propList reads scalars and lists alike", () => {
  assert.deepEqual(propList({ contact: "Gero" }, "contact"), ["Gero"]);
  assert.deepEqual(propList({ contact: ["Gero", "Noa"] }, "contact"), ["Gero", "Noa"]);
  assert.deepEqual(propList({}, "contact"), []);
  assert.deepEqual(propList({ contact: null }, "contact"), []);
  assert.deepEqual(propList({ contact: ["Gero", 42] }, "contact"), ["Gero"], "non-strings drop");
});

test("propListValue is the round-trip-stable stored form", () => {
  assert.equal(propListValue([]), null, "empty clears the prop");
  assert.equal(propListValue(["Gero"]), "Gero", "one stays a scalar");
  assert.deepEqual(propListValue(["Gero", "Noa"]), ["Gero", "Noa"]);
});

test("toggleValue adds and removes case-insensitively", () => {
  assert.deepEqual(toggleValue(["Gero"], "Noa"), ["Gero", "Noa"]);
  assert.deepEqual(toggleValue(["Gero", "Noa"], "gero"), ["Noa"]);
  assert.deepEqual(toggleValue([], "Gero"), ["Gero"]);
});

test("relationCandidates lists the target database, title-sorted, deduped", () => {
  const notes = [
    note("Noa.md", { type: "CONTACT" }),
    note("Slow Bloom EP.md", { type: "release" }),
    note("Gero.md", { type: "contact" }),
    note("Archive/Gero.md", { type: "contact" }, "gero"),
    note("Untyped.md", {}),
  ];
  const cands = relationCandidates(notes, "contact");
  assert.deepEqual(
    cands.map((c) => c.title),
    ["gero", "Noa"],
    "title sort wins (locale: lowercase first), duplicates collapse to the first note"
  );
  assert.equal(cands[0].path, "Archive/Gero.md");
  assert.deepEqual(relationCandidates(notes, "label"), []);
});

test("filterCandidates fuzzy-ranks without losing the empty-query order", () => {
  const cands = relationCandidates(
    [note("Noa.md", { type: "contact" }), note("Gero.md", { type: "contact" })],
    "contact"
  );
  assert.deepEqual(filterCandidates(cands, ""), cands, "empty query keeps order");
  assert.deepEqual(
    filterCandidates(cands, "no").map((c) => c.title),
    ["Noa"]
  );
  assert.deepEqual(
    filterCandidates(cands, "g").map((c) => c.title),
    ["Gero"],
    "prefix beats substring"
  );
  assert.deepEqual(filterCandidates(cands, "zzz"), []);
});

test("relatedGroups buckets by source database, largest first", () => {
  const entries: RelatedEntry[] = [
    { path: "a.md", title: "A", db_type: "release", prop: "contact" },
    { path: "b.md", title: "B", db_type: "RELEASE", prop: "contact" },
    { path: "c.md", title: "C", db_type: "press", prop: "writer" },
  ];
  const groups = relatedGroups(entries);
  assert.deepEqual(
    groups.map((g) => [g.dbType, g.entries.length]),
    [
      ["release", 2],
      ["press", 1],
    ]
  );
  assert.deepEqual(relatedGroups([]), []);
});

test("propValues and matchesFilters see each entry of a multi-value prop", () => {
  const n = note("Slow Bloom EP.md", { type: "release", contact: ["Gero", "Noa"] });
  assert.deepEqual(propValues(n, "contact"), ["Gero", "Noa"]);
  assert.deepEqual(propValues(n, "missing"), []);
  assert.ok(matchesFilters(n, [{ key: "contact", values: ["gero"] }]));
  assert.ok(matchesFilters(n, [{ key: "contact", values: ["no"] }]), "prefix hits a later entry");
  assert.ok(!matchesFilters(n, [{ key: "contact", values: ["x"] }]));
  // scalar props behave exactly as before
  assert.ok(matchesFilters(n, [{ key: "type", values: ["rel"] }]));
});

test("chipCommitValue keeps a list-valued prop a list through the plain editor", () => {
  // scalar props are untouched — the plain chip editor's normal case
  assert.equal(chipCommitValue("Gero", "Noa"), "Noa");
  assert.equal(chipCommitValue(undefined, "Noa"), "Noa");
  // a stored list displays comma-joined; committing that text back must NOT
  // collapse it into one scalar string
  assert.deepEqual(chipCommitValue(["Vinyl", "Digital"], "Vinyl, Digital"), ["Vinyl", "Digital"]);
  assert.deepEqual(chipCommitValue(["Vinyl", "Digital"], "Vinyl, Digital, Tape"), [
    "Vinyl",
    "Digital",
    "Tape",
  ]);
  // editing down to one value stores the scalar form, like propListValue
  assert.equal(chipCommitValue(["Vinyl", "Digital"], "Vinyl"), "Vinyl");
  // separator-only text can't mean "remove" here — the caller's empty check
  // owns that; fall back to the literal text
  assert.equal(chipCommitValue(["Vinyl", "Digital"], ","), ",");
});
