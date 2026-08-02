import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOIST_MIN,
  hoistAboveContent,
  onlyFallbacks,
  rankCommands,
  rankScore,
} from "./palette.ts";

type Row = { id: string; label: string; section: string; dest?: string };
const row = (id: string, section: string, label = id, dest?: string): Row => ({
  id,
  label,
  section,
  dest,
});

/** the command set the audit shot renders for query "release" (SUB-171) */
function releaseCommands(): Row[] {
  return [
    row("cmd:new", "Commands", "New note “release”"),
    row("cmd:newfolder", "Commands", "New folder…"),
    row("cmd:tasks", "Commands", "Go to Tasks", "Tasks"),
    row("cmd:notes", "Commands", "Go to Notes", "Notes"),
    row("cmd:trash", "Commands", "Open Trash", "Trash"),
    row("cmd:db:release", "Commands", "Go to Release", "Release"),
  ];
}

test("rankScore: a destination name lifts its row into the prefix band", () => {
  const go = row("cmd:db:release", "Commands", "Go to Release", "Release");
  // the label alone is only a word-start match (< 700); the dest is a prefix
  assert.ok(rankScore("release", go) >= HOIST_MIN);

  const plain = row("cmd:new", "Commands", "New note “release”");
  assert.ok(rankScore("release", plain) < rankScore("release", go));
});

test("rankCommands: best score first, the exact db name beats New note", () => {
  const { ranked, hoisted } = rankCommands("release", releaseCommands());
  assert.equal(ranked[0].id, "cmd:db:release");
  assert.deepEqual(
    hoisted.map((c) => c.id),
    ["cmd:db:release"],
  );
});

test("rankCommands: an empty query keeps declaration order, hoists nothing", () => {
  const cmds = releaseCommands();
  const { ranked, hoisted } = rankCommands("   ", cmds);
  assert.deepEqual(ranked, cmds);
  assert.deepEqual(hoisted, []);
});

test("rankCommands: score ties keep declaration order", () => {
  // "Go to Tasks" and "Go to Notes" are both prefix matches of equal length
  const { ranked } = rankCommands("go to", releaseCommands());
  assert.equal(ranked[0].id, "cmd:tasks");
  assert.equal(ranked[1].id, "cmd:notes");
});

test("rankCommands: non-destinations rank but never hoist", () => {
  const cmds = [row("cmd:rel", "Commands", "Release checklist…")];
  const { ranked, hoisted } = rankCommands("release", cmds);
  assert.equal(ranked.length, 1, "prefix match still ranks");
  assert.deepEqual(hoisted, []);
});

test("rankCommands: a mid-name substring matches without hoisting", () => {
  // "eleas" sits mid-word in both labels: both rank (500 band), neither hoists
  const { ranked, hoisted } = rankCommands("eleas", releaseCommands());
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["cmd:db:release", "cmd:new"],
  );
  assert.deepEqual(hoisted, []);
});

test("hoistAboveContent: hoisted rows land directly under the Notes section", () => {
  const items = [
    row("note:a", "Notes"),
    row("note:b", "Notes"),
    row("hit:a", "Content"),
    row("cmd:searchall", "Search"),
    row("cmd:new", "Commands"),
    row("cmd:db:release", "Commands", "Go to Release", "Release"),
  ];
  const out = hoistAboveContent(items, [items[5]]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["note:a", "note:b", "cmd:db:release", "hit:a", "cmd:searchall", "cmd:new"],
  );
});

test("hoistAboveContent: no Notes rows — hoisted goes above Content", () => {
  const items = [
    row("hit:a", "Content"),
    row("cmd:searchall", "Search"),
    row("cmd:db:release", "Commands", "Go to Release", "Release"),
  ];
  const out = hoistAboveContent(items, [items[2]]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["cmd:db:release", "hit:a", "cmd:searchall"],
  );
});

test("hoistAboveContent: no sections at all — hoisted goes first", () => {
  const items = [row("cmd:new", "Commands"), row("cmd:tasks", "Commands", "Go to Tasks", "Tasks")];
  const out = hoistAboveContent(items, [items[1]]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["cmd:tasks", "cmd:new"],
  );
});

test("hoistAboveContent: nothing hoisted leaves the list untouched", () => {
  const items = [row("note:a", "Notes"), row("cmd:new", "Commands")];
  assert.deepEqual(hoistAboveContent(items, []), items);
});

/**
 * SUB-673: the fallback rows echo the query in their labels, so they always
 * survive ranking. The banner used to key off an id whitelist and went dark
 * the moment "New sheet" joined them.
 */
type FbRow = { id: string; label: string; fallback?: true };
const fb = (id: string, label: string): FbRow => ({ id, label, fallback: true });
/** a real match — no fallback flag */
const hit = (id: string, label: string): FbRow => ({ id, label });

test("onlyFallbacks: query-echoing rows alone mean zero real hits", () => {
  assert.equal(onlyFallbacks([fb("cmd:new", "New note “zzzqqq”")]), true);
  assert.equal(
    onlyFallbacks([
      fb("cmd:new", "New note “zzzqqq”"),
      fb("cmd:newsheet", "New sheet “zzzqqq”"),
      fb("cmd:searchall", "See all results for “zzzqqq”…"),
    ]),
    true,
  );
});

test("onlyFallbacks: a real hit next to the fallbacks is not 'no results'", () => {
  assert.equal(
    onlyFallbacks([
      hit("note:a", "Release plan"),
      fb("cmd:new", "New note “release”"),
      fb("cmd:newsheet", "New sheet “release”"),
    ]),
    false,
  );
});

test("onlyFallbacks: a non-echoing command is a real hit", () => {
  // "New folder…" only shows when the query fuzzy-matches it
  assert.equal(
    onlyFallbacks([hit("cmd:newfolder", "New folder…"), fb("cmd:new", "New note “fold”")]),
    false,
  );
});

test("onlyFallbacks: an empty list is not 'no results' (still loading)", () => {
  assert.equal(onlyFallbacks([]), false);
});
