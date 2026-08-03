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

test("stripMachineFences: a view fence with an info-string tail still strips (SUB-899)", () => {
  // the editor and hub render ```view <anything> as a live widget (first
  // word decides), so its config must leave the search index like the bare
  // form — including a stray trailing space after ```view
  for (const open of ["```view table", "```view "]) {
    const out = stripMachineFences(`a\n${open}\nquery: secret\n\`\`\`\nb`);
    assert.ok(!out.includes("secret"), `config stripped for "${open}"`);
    assert.equal(out.split("\n").length, 5, "line count preserved");
  }
  // chart/csv/formulas parsers are strict bare-form: a tailed fence is NOT
  // machine content (it renders as a plain code box), so it stays searchable
  const chart = "a\n```chart x\nsource: r\n```\nb";
  assert.equal(stripMachineFences(chart), chart, "tailed chart fence stays prose");
});

test("stripMachineFences handles CRLF fences (SUB-913)", () => {
  const body = "prose\r\n```view\r\ntype: release\r\n```\r\ntail";
  const out = stripMachineFences(body);
  assert.ok(!out.includes("type: release"), "fence body blanked");
  assert.ok(out.includes("prose"), "prose kept");
  assert.ok(out.includes("tail"), "tail kept");
  // newline-for-newline: line numbers must keep mapping
  assert.equal(out.split("\n").length, body.split("\n").length);
});
