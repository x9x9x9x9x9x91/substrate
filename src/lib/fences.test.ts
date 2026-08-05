import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BARE_MACHINE_FENCE_LANGS,
  TAILED_MACHINE_FENCE_LANGS,
  isTailedBareFence,
  stripMachineFences,
} from "./fences.ts";
import { collectCardsFences } from "./metriccards.ts";
import { findFence } from "./sheet.ts";

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

test("stripMachineFences blanks view/chart/progress/timeline/csv/formulas bodies (SUB-261)", () => {
  const body = [
    "Label hub prose.",
    "",
    "```view",
    "type: release",
    "query: status:mastering",
    "view: table",
    "```",
    "",
    "```timeline",
    "source: release",
    "start: created",
    "label: title",
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
    "start",
    "yield_usd",
    "SUM",
    "```view",
  ])
    assert.ok(!out.includes(config), `${config} stripped`);
  assert.ok(out.includes("Label hub prose."), "prose before survives");
  assert.ok(out.includes("trail prose line"), "prose after survives");
  assert.equal(out.split("\n").length, body.split("\n").length, "line count preserved");
});

test("stripMachineFences blanks a ```calendar body too (SUB-965)", () => {
  const body = [
    "Release plan.",
    "",
    "```calendar",
    "source: release",
    "date: released",
    "query: status:mastering",
    "```",
    "",
    "after",
  ].join("\n");
  const out = stripMachineFences(body);
  for (const config of ["source", "released", "mastering", "```calendar"])
    assert.ok(!out.includes(config), `${config} stripped`);
  assert.ok(out.includes("Release plan."), "prose before survives");
  assert.ok(out.includes("after"), "prose after survives");
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
  // csv/formulas/heatmap/calendar parsers are strict bare-form: a tailed one renders
  // as plain code and stays searchable prose — as does any tailed user code
  // fence.
  for (const prose of [
    "a\n```csv raw\nsecret,1\n```\nb",
    "a\n```formulas x\nsecret = A1\n```\nb",
    "a\n```heatmap year\nsecret: session\n```\nb",
    "a\n```calendar month\nsecret: 1\n```\nb",
    "a\n```python foo\nsecret = 1\n```\nb",
    // The timeline parser is strict bare-form too.
    "a\n```timeline compact\nsource: release\n```\nb",
  ]) {
    assert.equal(stripMachineFences(prose), prose, "tailed bare-form fence stays prose");
  }
  // …and the BARE timeline opener is machine content that strips.
  const timeline = "a\n```timeline\nsource: release\nstart: created\nlabel: title\n```\nb";
  assert.ok(!stripMachineFences(timeline).includes("source: release"), "bare timeline strips");
});

test("stripMachineFences: bare heatmap strips, tailed heatmap stays prose (SUB-966)", () => {
  // the two halves of the bare-form contract, on the fence this branch adds:
  // the hub renders ONLY the bare opener live (its isTailedBareFence
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

test("stripMachineFences folds case exactly where dispatch does (SUB-1104)", () => {
  // Every live-dispatch reader lowercases the info string's first word before
  // matching, so ```View renders a widget just like ```view. The strip pass
  // used to compare case-sensitively, which left a rendering fence's config
  // in the search index — a leak across all live-dispatch languages.
  // Lockstep twin: machine_fence_strip_folds_case_like_dispatch in
  // src-tauri/src/vault/mod.rs asserts this same corpus.
  for (const open of [
    "```View",
    "```VIEW",
    "```vIeW table",
    "```Chart",
    "```CHART compact",
    "```Cards",
    "```CaRdS two-up",
    // bare-form, but the hub lowercases before dispatching, so a bare mixed-case
    // heatmap renders the live year grid and must leave the index
    "```HeatMap",
    "```HEATMAP",
  ]) {
    const out = stripMachineFences(`a\n${open}\nquery: secret\n\`\`\`\nb`);
    assert.ok(!out.includes("secret"), `config stripped for "${open}"`);
    assert.equal(out.split("\n").length, 5, "line count preserved");
  }

  // Coupled to a real dispatch reader rather than to a copy of the lang list:
  // collectCardsFences is what the hub uses to find its ```cards strips, and
  // it lowercases. Whatever IT accepts, the stripper must strip — if dispatch
  // ever stops folding case, this half fails and the contract gets re-decided
  // rather than silently drifting.
  const mixed = "a\n```Cards\nlabel: secret\n```\nb";
  assert.deepEqual(collectCardsFences(mixed), ["label: secret"], "dispatch accepts mixed case");
  assert.ok(!stripMachineFences(mixed).includes("secret"), "so the strip pass must too");

  // The bare-form group is the other half of the same rule: findFence matches
  // the literal opener, so ```CSV dispatches as NOTHING — it renders as a
  // plain code box, i.e. someone's prose, and must stay searchable. Stripping
  // it would drop a user's own content out of search while closing no leak.
  const upperCsv = "a\n```CSV\nat,yield_usd\n```\nb";
  assert.equal(findFence(upperCsv, "csv"), null, "dispatch ignores mixed-case csv");
  assert.equal(stripMachineFences(upperCsv), upperCsv, "so it stays searchable prose");
  const upperFormulas = "a\n```Formulas\ntotal = SUM(a)\n```\nb";
  assert.equal(findFence(upperFormulas, "formulas"), null, "dispatch ignores mixed-case formulas");
  assert.equal(stripMachineFences(upperFormulas), upperFormulas, "so it stays searchable prose");

  // heatmap is bare-form like csv/formulas but folds case like the tailed
  // group, because its hub dispatcher lowercases — the two rules are
  // separate axes. There is no dispatch-coupled assertion here the way there is
  // for cards/csv: the reader that folds case is HubDashboard's renderMarkdown,
  // a React component this suite cannot import, and heatmap.ts's
  // parseHeatmapBlocks is the OTHER, case-sensitive reader — asserting against
  // it would pin the narrower rule and re-open the leak.
  const tailedMixed = "a\n```HeatMap year\nsource: session\n```\nb";
  assert.equal(stripMachineFences(tailedMixed), tailedMixed, "tailed mixed-case heatmap is prose");
});

test("every declared fence language behaves like its group (generated)", () => {
  // Generated from the two exported lists, so a language added later is
  // exercised without anyone remembering to extend the corpora above. What it
  // is FOR is the group it landed in: the tailed/bare split is the thing
  // scripts/check-fence-langs.ts compares across the TS/Rust lockstep, and a
  // language filed under the wrong one strips differently in the two halves of
  // the app.
  const fence = (open: string) => "a\n" + open + "\nsecret: 1\n```\nb";
  const blanked = "a\n\n\n\nb"; // newline-for-newline: five lines in, five out
  for (const lang of [...TAILED_MACHINE_FENCE_LANGS, ...BARE_MACHINE_FENCE_LANGS]) {
    assert.equal(stripMachineFences(fence("```" + lang)), blanked, "bare " + lang + " strips");
  }
  for (const lang of TAILED_MACHINE_FENCE_LANGS) {
    const body = fence("```" + lang + " wide");
    assert.equal(stripMachineFences(body), blanked, "tailed " + lang + " strips");
  }
  for (const lang of BARE_MACHINE_FENCE_LANGS) {
    const body = fence("```" + lang + " wide");
    assert.equal(stripMachineFences(body), body, "tailed " + lang + " stays prose");
  }
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

test("isTailedBareFence marks exactly the tailed bare-form openers (SUB-965)", () => {
  // the predicate every first-word dispatcher asks before mounting a widget:
  // true means "prose, render a code box", which is what the stripper above
  // already assumes of these openers.
  for (const [lang, tail] of [
    ["calendar", "month"],
    ["csv", "raw"],
    ["formulas", "x"],
    ["CALENDAR", "month"],
  ] as const) {
    assert.equal(isTailedBareFence(lang, tail), true, `${lang} ${tail} is prose`);
  }
  // a bare opener of the same languages is machine content, and so is any
  // opener — tailed or not — of a live-dispatch or user language
  for (const [lang, tail] of [
    ["calendar", ""],
    ["csv", ""],
    ["formulas", ""],
    ["calendar", "\r"], // a CRLF body's opener line, not a tail
    ["view", "table"],
    ["chart", "compact"],
    ["cards", "two-up"],
    ["ts", "foo"],
  ] as const) {
    assert.equal(isTailedBareFence(lang, tail), false, `${lang} "${tail}" dispatches normally`);
  }
});
