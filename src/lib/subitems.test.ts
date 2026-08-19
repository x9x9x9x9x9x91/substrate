import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, PropSchema } from "./types.ts";
import { typeParentProp } from "./types.ts";
import { parentLinks, subSummaries, treeSection } from "./subitems.ts";
import { dbColumns } from "./dbcolumns.ts";
import { orderedPropKeys } from "./proporder.ts";
import { isReservedSchemaName } from "./schemalookup.ts";

/** A NoteMeta fixture: title defaults to the path's stem. */
function note(path: string, props: Record<string, unknown> = {}, title?: string): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop()!;
  return {
    path,
    stem,
    title: title ?? stem,
    folder: path.split("/").slice(0, -1).join("/"),
    props,
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const TASK_SCHEMA: Record<string, PropSchema> = {
  "Parent task": { options: [], kind: "relation", type: "task" },
  status: { options: [] },
};

const titles = (rows: NoteMeta[]) => rows.map((n) => n.title);

test("the parent mark reads back only as a self-pointing relation prop", () => {
  const marked = { ...TASK_SCHEMA, parent: "parent TASK" } as unknown as Record<string, PropSchema>;
  assert.equal(typeParentProp(marked, "task"), "Parent task", "canonical key, case-folded");
  assert.equal(typeParentProp(marked, "TASK"), "Parent task", "db name folds too");
  assert.equal(typeParentProp(TASK_SCHEMA, "task"), undefined, "unmarked");
  // hand-edited schemas that dangle or retype the mark read as no tree
  assert.equal(
    typeParentProp({ ...TASK_SCHEMA, parent: "gone" } as unknown as Record<string, PropSchema>, "task"),
    undefined
  );
  assert.equal(
    typeParentProp({ ...TASK_SCHEMA, parent: "status" } as unknown as Record<string, PropSchema>, "task"),
    undefined,
    "not a relation"
  );
  assert.equal(
    typeParentProp(
      { Up: { options: [], kind: "relation", type: "release" }, parent: "Up" } as unknown as Record<
        string,
        PropSchema
      >,
      "task"
    ),
    undefined,
    "points at another database"
  );
});

test("parent links match by title or stem, and drop self-links, danglers and cycles", () => {
  const notes = [
    note("T/Album.md"),
    note("T/Mixdown.md", { "Parent task": "album" }),
    note("T/Notes.md", { "Parent task": "Album Art Stem" }, "Album art"),
    note("T/Ghost.md", { "Parent task": "Nothing here" }),
    note("T/Self.md", { "Parent task": "Self" }),
    note("T/A.md", { "Parent task": "B" }),
    note("T/B.md", { "Parent task": "A" }),
  ];
  // "Notes.md" carries the title "Album art"; the stem match feeds it too
  notes[2] = note("T/Album Art Stem.md", { "Parent task": "Album" }, "Album art");
  const links = parentLinks(notes, "Parent task");
  assert.equal(links.get("T/Mixdown.md"), "T/Album.md", "title match, case-folded");
  assert.equal(links.get("T/Album Art Stem.md"), "T/Album.md");
  assert.equal(links.has("T/Ghost.md"), false, "dangling value links nothing");
  assert.equal(links.has("T/Self.md"), false, "a row can't parent itself");
  assert.equal(links.has("T/A.md"), false, "a cycle links nothing…");
  assert.equal(links.has("T/B.md"), false, "…at either end");
});

test("a list-valued parent relation takes the first link that resolves", () => {
  const notes = [
    note("T/Album.md"),
    note("T/Kid.md", { "Parent task": ["Nothing here", "Album"] }),
  ];
  assert.equal(parentLinks(notes, "Parent task").get("T/Kid.md"), "T/Album.md");
});

test("the parent prop is read case-folded off the note, like any cell", () => {
  const notes = [note("T/Album.md"), note("T/Kid.md", { "PARENT TASK": "Album" })];
  assert.equal(parentLinks(notes, "Parent task").get("T/Kid.md"), "T/Album.md");
});

test("summaries climb the chain: descendants counted, complete ones tallied", () => {
  const notes = [
    note("T/Album.md"),
    note("T/Mix.md", { "Parent task": "Album", status: "done" }),
    note("T/Master.md", { "Parent task": "Album", status: "todo" }),
    note("T/Stem.md", { "Parent task": "Mix", status: "cancelled" }),
    note("T/Loose.md"),
  ];
  const sums = subSummaries(notes, parentLinks(notes, "Parent task"));
  assert.deepEqual(sums.get("T/Album.md"), { total: 3, done: 2 }, "grandchild climbs too");
  assert.deepEqual(sums.get("T/Mix.md"), { total: 1, done: 1 });
  assert.equal(sums.has("T/Loose.md"), false, "childless rows carry no badge");
});

test("children nest under their parent, one level, in sort order", () => {
  const rows = [
    note("T/Album.md", {}, "Album"),
    note("T/Bench.md", {}, "Bench"),
    note("T/Mix.md", { "Parent task": "Album" }, "Mix"),
    note("T/Master.md", { "Parent task": "Album" }, "Master"),
  ];
  const links = parentLinks(rows, "Parent task");
  const tree = treeSection(rows, links, new Set());
  assert.deepEqual(titles(tree.rows), ["Album", "Mix", "Master", "Bench"]);
  assert.equal(tree.depth.get("T/Mix.md"), 1);
  assert.equal(tree.depth.get("T/Bench.md"), 0);
  assert.equal(tree.childCount.get("T/Album.md"), 2);
  assert.equal(tree.childCount.has("T/Bench.md"), false);
});

test("one level is the cap: a grandchild stands flat, hanging off nobody here", () => {
  const rows = [
    note("T/Album.md", {}, "Album"),
    note("T/Mix.md", { "Parent task": "Album" }, "Mix"),
    note("T/Stem.md", { "Parent task": "Mix" }, "Stem"),
  ];
  const tree = treeSection(rows, parentLinks(rows, "Parent task"), new Set());
  assert.deepEqual(titles(tree.rows), ["Album", "Mix", "Stem"]);
  assert.equal(tree.depth.get("T/Mix.md"), 1, "child indents");
  assert.equal(tree.depth.get("T/Stem.md"), 0, "grandchild does NOT indent twice");
  assert.equal(tree.childCount.get("T/Mix.md"), undefined, "…so it hangs off nobody here");
  assert.equal(tree.childCount.get("T/Album.md"), 1);
});

test("collapsing a parent drops its children from the row list entirely", () => {
  const rows = [
    note("T/Album.md", {}, "Album"),
    note("T/Mix.md", { "Parent task": "Album" }, "Mix"),
    note("T/Bench.md", {}, "Bench"),
  ];
  const links = parentLinks(rows, "Parent task");
  const open = treeSection(rows, links, new Set());
  const shut = treeSection(rows, links, new Set(["T/Album.md"]));
  assert.deepEqual(titles(open.rows), ["Album", "Mix", "Bench"]);
  assert.deepEqual(titles(shut.rows), ["Album", "Bench"], "collapsed children aren't rows");
  assert.equal(
    shut.childCount.get("T/Album.md"),
    1,
    "the chevron still knows what it hides"
  );
  assert.equal(shut.depth.has("T/Mix.md"), false);
});

test("a child whose parent is in another section stands on its own", () => {
  const all = [
    note("T/Album.md", { status: "live" }, "Album"),
    note("T/Mix.md", { "Parent task": "Album", status: "todo" }, "Mix"),
  ];
  const links = parentLinks(all, "Parent task");
  // grouped: parent and child land in different boxes
  const groupA = treeSection([all[0]], links, new Set());
  const groupB = treeSection([all[1]], links, new Set());
  assert.deepEqual(titles(groupA.rows), ["Album"]);
  assert.deepEqual(titles(groupB.rows), ["Mix"]);
  assert.equal(groupB.depth.get("T/Mix.md"), 0, "no orphan indent");
  assert.equal(groupA.childCount.has("T/Album.md"), false, "no chevron over an empty box");
  // …while its db-wide summary still counts the child
  assert.deepEqual(subSummaries(all, links).get("T/Album.md"), { total: 1, done: 0 });
});

test("a filtered-away parent leaves its child as a plain top-level row", () => {
  const all = [
    note("T/Album.md", {}, "Album"),
    note("T/Mix.md", { "Parent task": "Album" }, "Mix"),
  ];
  const tree = treeSection([all[1]], parentLinks(all, "Parent task"), new Set());
  assert.deepEqual(titles(tree.rows), ["Mix"]);
  assert.equal(tree.depth.get("T/Mix.md"), 0);
});

test("the mark is housekeeping, not a column of its own", () => {
  /* `parent` rides the flat prop map beside `icon` and `home` — a string
     where every neighbour is a PropSchema. Every surface that walks schema
     keys has to skip it the same way, or the mark shows up as a phantom
     empty column (and a phantom property row, and a suggestion). */
  const marked = { ...TASK_SCHEMA, parent: "Parent task" } as unknown as Record<string, PropSchema>;
  const rows = [note("Tasks/Master.md", { type: "task" })];
  assert.deepEqual(dbColumns(rows, marked), ["status", "Parent task"], "no `parent` column");
  assert.ok(isReservedSchemaName("Parent"), "folded, like the schema keys beside it");
  assert.deepEqual(
    orderedPropKeys({ status: "todo" }, marked),
    ["status"],
    "and no `parent` row in a note's property list"
  );
  // a row that really carries a `parent` value in its OWN frontmatter still
  // gets its column: the reserved key shadows the schema entry, not the note
  assert.ok(dbColumns([note("Tasks/Hand.md", { parent: "Master" })], marked).includes("parent"));
});
