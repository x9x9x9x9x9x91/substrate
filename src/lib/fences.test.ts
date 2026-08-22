import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BARE_MACHINE_FENCE_LANGS,
  hasUnclosedFence,
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

test("stripMachineFences: a bare-form opener typed with a stray space still strips", () => {
  // ```calendar␠ names no second word — it is the bare opener with a stray
  // space, the likeliest way to mistype one by hand, and every bare-form
  // parser reads it as the opener and draws the live board. A drawn board
  // whose config sits in the search index is the leak this strip exists to
  // close. Lockstep twin: machine_fence_strip_accepts_stray_opener_space in
  // src-tauri/src/vault/mod.rs asserts this same corpus.
  for (const lang of BARE_MACHINE_FENCE_LANGS) {
    for (const pad of [" ", "\t", "  "]) {
      const body = "a\n```" + lang + pad + "\nsecret: 1\n```\nb";
      assert.equal(stripMachineFences(body), "a\n\n\n\nb", lang + " with padding strips");
    }
  }
  // …and the same opener on a CRLF body, where the padding sits before the CR
  const crlf = "a\r\n```calendar \r\nsecret: 1\r\n```\r\nb";
  assert.ok(!stripMachineFences(crlf).includes("secret"), "stray space before CRLF strips");
  // a real second word is still prose, padded or not
  const prose = "a\n```calendar month \nsecret: 1\n```\nb";
  assert.equal(stripMachineFences(prose), prose, "a tailed bare-form opener stays prose");
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
    // whitespace no parser skips: only [ \t] is the bare-opener allowance, so
    // a non-breaking space stays prose on every surface rather than mounting a
    // live board whose config no stripper reaches
    ["calendar", "\u00a0"],
    ["csv", " \u00a0"],
    ["formulas", "\u3000"],
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
    ["calendar", " "], // a stray space is not a second word
    ["csv", " \t"],
    ["formulas", " \r"],
    ["view", "table"],
    ["chart", "compact"],
    ["cards", "two-up"],
    ["ts", "foo"],
  ] as const) {
    assert.equal(isTailedBareFence(lang, tail), false, `${lang} "${tail}" dispatches normally`);
  }
});

test("hasUnclosedFence sees the closing line that never came", () => {
  // the case the parsers are blind to by construction: their "```lang\n … ```"
  // pattern matches nothing here, so the board counted zero fences and said
  // nothing about the one that is plainly written in the note
  assert.equal(hasUnclosedFence("```chart\nsource: release\n", "chart"), true);
  assert.equal(hasUnclosedFence("```chart\nsource: release\n```\n", "chart"), false);
  // a closed fence followed by an open one of the same language
  assert.equal(
    hasUnclosedFence("```chart\nx: a\n```\n\ntext\n\n```chart\nx: b\n", "chart"),
    true
  );
  // the last opener is what is left open — a chart that closed and a heatmap
  // that did not is the heatmap's problem, not the chart's
  const mixed = "```chart\nx: a\n```\n```heatmap\nsource: release\n";
  assert.equal(hasUnclosedFence(mixed, "chart"), false);
  assert.equal(hasUnclosedFence(mixed, "heatmap"), true);
  // case follows the parser that asks: the heatmap parser's own opener folds
  // case, the others match the literal spelling
  const shouty = "```HeatMap\nsource: release\n";
  assert.equal(hasUnclosedFence(shouty, "heatmap"), false);
  assert.equal(hasUnclosedFence(shouty, "heatmap", true), true);
  // an opener with a tail still opens (```chart compact)
  assert.equal(hasUnclosedFence("```chart compact\nx: a\n", "chart"), true);
  // a ``` that carries prose on its line still CLOSES the fence, because that
  // is what "match to the next ```" does — the parser reads a block here and
  // shows its own message about it, so a banner would be a second, wronger
  // answer over a fence the board already spoke about
  assert.equal(hasUnclosedFence("```chart\n``` inside prose\nx: a\n", "chart"), false);
  // nothing open at all, and a user's own code fence, are both silent
  assert.equal(hasUnclosedFence("just prose\n", "chart"), false);
  assert.equal(hasUnclosedFence("```ts\nconst x = 1;\n", "chart"), false);
  // CRLF openers close the same way
  assert.equal(hasUnclosedFence("```chart\r\nx: a\r\n```\r\n", "chart"), false);
  assert.equal(hasUnclosedFence("```chart\r\nx: a\r\n", "chart"), true);
})

test("hasUnclosedFence closes a fence wherever the parser closes it", () => {
  // the shapes that used to raise a banner over a board that had just drawn
  // the chart: the parsers close on the next ``` ANYWHERE, so an indented
  // closer and a closer carrying an info string both close the fence
  assert.equal(hasUnclosedFence("```chart\nx: a\n  ```\n", "chart"), false);
  assert.equal(hasUnclosedFence("```chart\nx: a\n```js\n", "chart"), false);
  assert.equal(hasUnclosedFence("```chart\nx: a\n``` \n", "chart"), false);
  // an unrelated block left open elsewhere is not this fence's problem, in
  // either order
  assert.equal(hasUnclosedFence("```chart\nx: a\n```\n\n```ts\nconst x = 1;\n", "chart"), false);
  assert.equal(hasUnclosedFence("```ts\nconst x = 1;\n```\n\n```chart\nx: a\n", "chart"), true);
  // a note QUOTING fence syntax inside a ~~~ block is writing prose about a
  // fence, not writing one
  assert.equal(hasUnclosedFence("~~~\n```chart\nx: a\n~~~\n", "chart"), false);
  assert.equal(hasUnclosedFence("~~~md\n```chart\nx: a\n~~~\n\n```chart\ny: b\n", "chart"), true);
  // the likeliest way to mistype an opener by hand — a trailing space — is
  // the one the parsers reject outright, so it must not go silent
  assert.equal(hasUnclosedFence("```chart \nx: a\n", "chart"), true);
  assert.equal(hasUnclosedFence("```heatmap\t\nsource: release\n", "heatmap", true), true);
  // an indented opener opens: the parsers' patterns are unanchored, so they
  // read one too
  assert.equal(hasUnclosedFence("  ```chart\nx: a\n", "chart"), true);
});
