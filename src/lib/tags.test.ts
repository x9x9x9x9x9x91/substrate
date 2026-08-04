import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inlineTagMatches,
  inlineTags,
  noteTags,
  notesInTagFolder,
  propTags,
  tagFolderApplyTags,
  tagFolderMatches,
  tagFolderSummary,
  tagOptions,
  tagQuery,
  tagUniverse,
} from "./tags.ts";
import type { NoteMeta, TagFolder } from "./types.ts";

// These mirror the tests in src-tauri/src/vault/tags.rs one-for-one — the two
// grammars are lockstep twins and drift here is a real bug, not a style
// difference. When a case changes on one side, change it on both.

test("inline grammar accepts prose tags", () => {
  assert.deepEqual(inlineTags("a #demo tag"), ["demo"]);
  assert.deepEqual(inlineTags("#start-of-line"), ["start-of-line"]);
  assert.deepEqual(inlineTags("(#parens) and [#brackets]"), ["parens", "brackets"]);
  assert.deepEqual(inlineTags("mid.#dot, #comma; #semi"), ["dot", "comma", "semi"]);
  assert.deepEqual(inlineTags("#a_b-c2"), ["a_b-c2"]);
  // trailing separators belong to the prose, not the tag
  assert.deepEqual(inlineTags("#demo- and #demo_"), ["demo"]);
});

test("inline grammar rejects non-tags", () => {
  // headings: `#` + space, or a run of `#`
  assert.deepEqual(inlineTags("# Heading\n### Deeper"), []);
  assert.deepEqual(inlineTags("##notatag"), []);
  // digits-first, which is what keeps issue numbers out
  assert.deepEqual(inlineTags("#1 and #404"), []);
  // known edge, documented in vault-format: a hex colour starting with a
  // letter reads as a tag. Carving hex out would swallow real short tags.
  assert.deepEqual(inlineTags("#ff00aa"), ["ff00aa"]);
  // word-internal
  assert.deepEqual(inlineTags("C#sharp"), []);
  assert.deepEqual(inlineTags("a_#b"), []);
  // HTML entities
  assert.deepEqual(inlineTags("&#x27;"), []);
});

test("inline grammar skips code and links", () => {
  assert.deepEqual(inlineTags("```\n#fenced\n```\n#real"), ["real"]);
  assert.deepEqual(inlineTags("~~~\n#tilde\n~~~\n#real"), ["real"]);
  assert.deepEqual(inlineTags("an `#inline` span and #real"), ["real"]);
  assert.deepEqual(inlineTags("[[Note#heading]] and #real"), ["real"]);
  assert.deepEqual(inlineTags("![[Asset#frag]] and #real"), ["real"]);
  assert.deepEqual(inlineTags("[text](https://x.test/p#frag) and #real"), ["real"]);
  assert.deepEqual(inlineTags("https://x.test/p#frag and #real"), ["real"]);
  assert.deepEqual(inlineTags("www.x.test/p#frag and #real"), ["real"]);
});

test("inline tags fold for dedupe and keep the first casing", () => {
  assert.deepEqual(inlineTags("#Demo then #demo then #DEMO"), ["Demo"]);
});

test("inlineTagMatches: offsets point at the # and exclude trailing separators", () => {
  const body = "see #demo- here";
  assert.deepEqual(inlineTagMatches(body), [{ tag: "demo", from: 4, to: 9 }]);
  assert.equal(body.slice(4, 9), "#demo");
  // every occurrence is its own chip, unlike the deduplicated list
  assert.deepEqual(
    inlineTagMatches("#a and #a").map((m) => m.from),
    [0, 7],
  );
});

test("prop tags accept a list or a scalar", () => {
  assert.deepEqual(propTags({ tags: ["demo", "live"] }), ["demo", "live"]);
  assert.deepEqual(propTags({ tags: "demo, live" }), ["demo", "live"]);
  assert.deepEqual(propTags({ tags: ["#demo"] }), ["demo"]);
  // the key itself folds, matching the engine's prop lookup
  assert.deepEqual(propTags({ Tags: ["demo"] }), ["demo"]);
  assert.deepEqual(propTags({ tags: [] }), []);
  assert.deepEqual(propTags({ tags: null }), []);
  assert.deepEqual(propTags({}), []);
  assert.deepEqual(propTags({ tags: ["demo", "DEMO"] }), ["demo"]);
});

test("noteTags unions both sources", () => {
  assert.deepEqual(noteTags({ tags: ["live", "demo"] }, "a #demo note"), ["demo", "live"]);
  assert.deepEqual(noteTags({ tags: ["DEMO"] }, "a #demo note"), ["demo"]);
  assert.deepEqual(noteTags({}, "a #demo note"), ["demo"]);
  assert.deepEqual(noteTags({ tags: ["demo"] }, "no inline tags"), ["demo"]);
});

function folder(over: Partial<TagFolder> = {}): TagFolder {
  return { id: "tf", name: "F", tags: ["demo"], match: "any", exclude: [], ...over };
}

test("tag folder query semantics: ANY, ALL, NOT", () => {
  assert.equal(tagFolderMatches(folder({ tags: ["demo", "live"] }), ["live"]), true);
  assert.equal(tagFolderMatches(folder({ tags: ["demo", "live"] }), ["other"]), false);
  const all = folder({ tags: ["demo", "live"], match: "all" });
  assert.equal(tagFolderMatches(all, ["demo", "live", "x"]), true);
  assert.equal(tagFolderMatches(all, ["demo"]), false);
  // exclusions veto however well the positives match
  const not = folder({ tags: ["demo"], exclude: ["archived"] });
  assert.equal(tagFolderMatches(not, ["demo"]), true);
  assert.equal(tagFolderMatches(not, ["demo", "archived"]), false);
  // matching folds on both sides
  assert.equal(tagFolderMatches(folder({ tags: ["Demo"] }), ["DEMO"]), true);
  assert.equal(tagFolderMatches(folder({ tags: ["demo"], exclude: ["Archived"] }), ["demo", "ARCHIVED"]), false);
  // an unfinished builder sweeps nothing into the folder
  assert.equal(tagFolderMatches(folder({ tags: [] }), ["demo"]), false);
  assert.equal(tagFolderMatches(folder({ tags: [], exclude: ["x"] }), ["demo"]), false);
});

test("acting inside a folder applies its positive tags only", () => {
  assert.deepEqual(tagFolderApplyTags(folder({ tags: ["demo", "live"], exclude: ["archived"] })), [
    "demo",
    "live",
  ]);
});

function note(path: string, tags: string[]): NoteMeta {
  return { path, stem: path, title: path, folder: "", props: {}, updated_ms: 0, excerpt: "", tags };
}

test("notesInTagFolder filters and keeps the caller's order", () => {
  const notes = [note("a", ["demo"]), note("b", ["other"]), note("c", ["demo", "archived"])];
  const picked = notesInTagFolder(folder({ exclude: ["archived"] }), notes).map((n) => n.path);
  assert.deepEqual(picked, ["a"]);
  // a note with no tags at all is never swept in
  assert.deepEqual(notesInTagFolder(folder(), [{ ...note("d", []), tags: undefined }]), []);
});

test("tagUniverse counts notes, most-used first, most common spelling wins", () => {
  const notes = [
    note("a", ["Demo", "live"]),
    note("b", ["demo"]),
    note("c", ["DEMO"]),
    note("d", ["demo"]),
  ];
  assert.deepEqual(tagUniverse(notes), [
    { tag: "demo", count: 4 },
    { tag: "live", count: 1 },
  ]);
  assert.deepEqual(tagUniverse([]), []);
  // a spelling tie breaks alphabetically, never by scan order — lockstep with
  // the tie case in tags.rs index_carries_the_union_and_the_universe
  assert.deepEqual(tagUniverse([note("a", ["demo"]), note("b", ["Demo"])]), [
    { tag: "Demo", count: 2 },
  ]);
});

test("tagQuery: only inside a tag being typed", () => {
  assert.deepEqual(tagQuery("a #de"), { from: 2, query: "de" });
  assert.deepEqual(tagQuery("#"), { from: 0, query: "" });
  assert.deepEqual(tagQuery("a #"), { from: 2, query: "" });
  // the boundary rule applies to completion too
  assert.equal(tagQuery("C#sh"), null);
  assert.equal(tagQuery("##"), null);
  assert.equal(tagQuery("&#x2"), null);
  // completed word, then space — no longer in a tag
  assert.equal(tagQuery("a #demo "), null);
  assert.equal(tagQuery("plain text"), null);
});

test("tagOptions: prefix matches before substring matches", () => {
  const universe = [
    { tag: "demo", count: 5 },
    { tag: "live-demo", count: 3 },
    { tag: "design", count: 2 },
    { tag: "other", count: 1 },
  ];
  assert.deepEqual(tagOptions("de", universe), ["demo", "design", "live-demo"]);
  assert.deepEqual(tagOptions("", universe), ["demo", "live-demo", "design", "other"]);
  assert.deepEqual(tagOptions("zzz", universe), []);
  // folded on both sides
  assert.deepEqual(tagOptions("DE", universe), ["demo", "design", "live-demo"]);
});

test("tagFolderSummary: the rule in words", () => {
  assert.equal(tagFolderSummary(folder({ tags: [] })), "No tags yet");
  assert.equal(tagFolderSummary(folder({ tags: ["demo"] })), "#demo");
  assert.equal(tagFolderSummary(folder({ tags: ["demo", "live"] })), "#demo or #live");
  assert.equal(
    tagFolderSummary(folder({ tags: ["demo", "live"], match: "all" })),
    "#demo and #live"
  );
  assert.equal(
    tagFolderSummary(folder({ tags: ["demo"], exclude: ["draft", "old"] })),
    "#demo, but not #draft or #old"
  );
});
