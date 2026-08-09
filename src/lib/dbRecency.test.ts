import { test } from "node:test";
import assert from "node:assert/strict";
import { dbTypesByRecency } from "./dbRecency.ts";
import type { NoteMeta } from "./types.ts";

function note(title: string, type: string | undefined, updated_ms: number): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: (type === undefined ? {} : { type }) as NoteMeta["props"],
    updated_ms,
    excerpt: "",
    sealed: false,
  };
}

test("dbTypesByRecency: most recently touched database first", () => {
  const notes = [
    note("a", "expense", 100),
    note("b", "task", 300),
    note("c", "expense", 200),
    note("d", "book", 250),
  ];
  assert.deepEqual(dbTypesByRecency(notes, ["expense", "book", "task"]), [
    "task",
    "book",
    "expense",
  ]);
});

test("dbTypesByRecency: matches types case- and whitespace-insensitively", () => {
  const notes = [note("a", "Expense ", 100), note("b", "task", 50)];
  assert.deepEqual(dbTypesByRecency(notes, ["task", "expense"]), ["expense", "task"]);
});

test("dbTypesByRecency: databases with no notes sort last, in the incoming order", () => {
  const notes = [note("a", "task", 10)];
  assert.deepEqual(dbTypesByRecency(notes, ["empty", "alsoEmpty", "task"]), [
    "task",
    "empty",
    "alsoEmpty",
  ]);
});

test("dbTypesByRecency: ties keep the incoming count-desc order", () => {
  const notes = [note("a", "big", 500), note("b", "small", 500)];
  // same max timestamp: the caller's order (count-desc) decides, not the name
  assert.deepEqual(dbTypesByRecency(notes, ["big", "small"]), ["big", "small"]);
  assert.deepEqual(dbTypesByRecency(notes, ["small", "big"]), ["small", "big"]);
});

test("dbTypesByRecency: untyped notes and unknown types don't rank anything", () => {
  const notes = [note("a", undefined, 900), note("b", "ghost", 800), note("c", "task", 5)];
  assert.deepEqual(dbTypesByRecency(notes, ["expense", "task"]), ["task", "expense"]);
});
