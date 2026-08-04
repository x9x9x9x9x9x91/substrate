import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMachineFences } from "./fences.ts";

test("stripMachineFences blanks a heatmap body too (SUB-966)", () => {
  const body = [
    "Sessions this year.",
    "",
    "```heatmap",
    "source: session",
    "date: logged",
    "value: sum:minutes",
    "```",
    "",
    "after",
  ].join("\n");
  const out = stripMachineFences(body);
  for (const config of ["source:", "logged", "minutes", "```heatmap"])
    assert.ok(!out.includes(config), `${config} stripped`);
  assert.ok(out.includes("Sessions this year."), "prose before survives");
  assert.ok(out.includes("after"), "prose after survives");
  assert.equal(out.split("\n").length, body.split("\n").length, "line count preserved");
});

test("stripMachineFences blanks view/chart/progress/csv/formulas bodies (SUB-261)", () => {
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
    "```progress",
    "label: Portfolio target",
    "value: {{Holdings.thermotarget}}",
    "target: 500000",
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
  for (const config of [
    "mastering",
    "query",
    "source",
    "thermotarget",
    "yield_usd",
    "SUM",
    "```view",
  ])
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

test("stripMachineFences: an info-string tail strips for live-dispatch langs (SUB-899, SUB-983)", () => {
  // the editor and hub render ```view/```chart/```progress/```cards <anything>
  // as a live widget (first word decides), so the config must leave the search
  // index like the bare form — including a stray trailing space after the
  // language. Lockstep twin: machine_fence_strip_covers_info_string_tails in
  // src-tauri/src/vault/mod.rs asserts this same corpus.
  const tailed = [
    "```view",
    "```view table",
    "```view ",
    "```chart compact",
    "```progress",
    "```progress wide",
    "```cards two-up",
  ];
  for (const open of tailed) {
    const out = stripMachineFences(`a\n${open}\nquery: secret\n\`\`\`\nb`);
    assert.ok(!out.includes("secret"), `config stripped for "${open}"`);
    assert.equal(out.split("\n").length, 5, "line count preserved");
  }
  // csv/formulas parsers are strict bare-form: a tailed one renders as plain
  // code and stays searchable prose — as does any tailed user code fence.
  for (const prose of [
    "a\n```csv raw\nsecret,1\n```\nb",
    "a\n```formulas x\nsecret = A1\n```\nb",
    "a\n```heatmap year\nsecret: session\n```\nb",
    "a\n```python foo\nsecret = 1\n```\nb",
  ]) {
    assert.equal(stripMachineFences(prose), prose, "tailed bare-form fence stays prose");
  }
});

test("stripMachineFences: bare heatmap strips, tailed heatmap stays prose (SUB-966)", () => {
  // the two halves of the bare-form contract, on the fence this branch adds:
  // the hub renders ONLY the bare opener live (HubDashboard's BARE_ONLY
  // guard), so only the bare one may leave the index. Lockstep twin:
  // machine_fence_strip_covers_heatmap_fences in src-tauri/src/vault/mod.rs.
  const bare = "a\n```heatmap\nsource: session\ndate: logged\n```\nb";
  assert.ok(!stripMachineFences(bare).includes("logged"), "bare heatmap config stripped");
  const tailed = "a\n```heatmap year\nsource: session\ndate: logged\n```\nb";
  assert.equal(stripMachineFences(tailed), tailed, "tailed heatmap fence stays prose");
});

test("stripMachineFences: an inline prose mention of an opener never blanks prose (SUB-983)", () => {
  // `` ```chart `` mentioned in running text carries a backtick right after
  // the language word; without the tail's backtick guard the old regex
  // swallowed the rest of the line and blanked everything to the next fence
  // (44 prose lines of docs/dashboards.md, 48 of the seeded AGENTS.md).
  const body = "One ` ```chart ` fence per chart; prose continues.\nmore prose\n```chart\nsource: r\n```\nafter";
  const out = stripMachineFences(body);
  assert.ok(out.includes("prose continues"), "inline mention line survives");
  assert.ok(out.includes("more prose"), "following prose survives");
  assert.ok(!out.includes("source: r"), "the real fence still strips");
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
