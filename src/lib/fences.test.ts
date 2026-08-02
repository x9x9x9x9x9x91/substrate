import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMachineFences } from "./fences.ts";

test("stripMachineFences blanks view/chart/csv/formulas bodies (SUB-261)", () => {
  const body = [
    "Label hub prose.",
    "",
    "```view",
    "type: release",
    "query: status:mastering",
    "view: table",
    "```",
    "",
    "```chart",
    "source: release",
    "y: count",
    "```",
    "",
    "```csv",
    "at,yield_usd",
    "2026-07-17 10:28,3",
    "```",
    "",
    "```formulas",
    "total = SUM(a)",
    "```",
    "",
    "trail prose line",
  ].join("\n");
  const out = stripMachineFences(body);
  for (const config of ["mastering", "query", "source", "yield_usd", "SUM", "```view"])
    assert.ok(!out.includes(config), `${config} stripped`);
  assert.ok(out.includes("Label hub prose."), "prose before survives");
  assert.ok(out.includes("trail prose line"), "prose after survives");
  assert.equal(out.split("\n").length, body.split("\n").length, "line count preserved");
});

test("stripMachineFences: user code fences stay searchable", () => {
  const body = "prose\n\n```ts\nconst mastering = 1;\n```\nafter\n";
  assert.equal(stripMachineFences(body), body, "untouched");
});

test("stripMachineFences: an unclosed fence blanks to EOF", () => {
  const out = stripMachineFences("prose\n\n```view\nquery: x\n");
  assert.equal(out, "prose\n\n\n\n", "nothing of the config leaks");
});

test("stripMachineFences: prose on the open/close lines survives", () => {
  const out = stripMachineFences("see below ```view\nquery: x\n``` done here\n");
  assert.ok(out.startsWith("see below \n"), "open-line prose kept");
  assert.ok(out.endsWith(" done here\n"), "close-line prose kept");
});
