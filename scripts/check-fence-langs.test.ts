import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkUseSites,
  collect,
  crossCheck,
  normalizeEnd,
  parseFencePattern,
  parseRustPattern,
  readSources,
  type FenceInventory,
} from "./check-fence-langs.ts";
import {
  HUB_BARE_MACHINE_FENCE_LANGS,
  MACHINE_FENCE_RE,
  SHEET_BARE_MACHINE_FENCE_LANGS,
  TAILED_MACHINE_FENCE_LANGS,
} from "../src/lib/fences.ts";

const JS_END = "(?:```|~~~|$)";
const RUST_END = "(?:```|~~~|\\z)";

/** A machine-fence pattern in the current grammar, for the given lang groups.
    The sheet group defaults to the real pair: most cases here exercise the two
    groups that share the lenient opener, and a group that is identical on both
    sides of a comparison contributes no finding. */
const pattern = (tailed: string, bare: string, end: string, sheet = "csv|formulas") =>
  "(?:(?:```|~~~)[ \\t]*(?:(?:" +
  tailed +
  ")(?:[ \\t][^`\\n]*)?|(?:" +
  bare +
  ")[ \\t]*)|```(?:" +
  sheet +
  ")[ \\t]*)\\r?\\n[\\s\\S]*?" +
  end;

const inv = (tailed: string, bare: string, end = JS_END, sheet = "csv|formulas"): FenceInventory =>
  parseFencePattern(pattern(tailed, bare, end, sheet), "test");

/* ── the real tree ──────────────────────────────────────────────────────── */

test("the checked-in TS and Rust fence grammars are in lockstep (SUB-1069)", () => {
  // The test that makes `npm test` fail: adding a language to one side alone
  // used to pass every suite in the repo.
  const { ts, rust } = collect();
  assert.deepEqual(crossCheck(ts, rust), []);
});

test("both sides still carry the declared fence languages", () => {
  // A parser that silently found nothing would satisfy the lockstep test above
  // by comparing two empty inventories. Checked against the exported lists
  // rather than a hand-copied literal, so adding a language does not need this
  // assertion edited — the point is that what comes back OUT of the pattern is
  // what went in, on both sides.
  const { ts, rust } = collect();
  for (const side of [ts, rust]) {
    assert.deepEqual(side.tailed, [...TAILED_MACHINE_FENCE_LANGS]);
    assert.deepEqual(side.bare, [...HUB_BARE_MACHINE_FENCE_LANGS]);
    assert.deepEqual(side.sheet, [...SHEET_BARE_MACHINE_FENCE_LANGS]);
  }
  assert.ok(
    ts.tailed.length > 0 && ts.bare.length > 0 && ts.sheet.length > 0,
    "no group is empty"
  );
});

test("case-folded languages come back decoded, in both groups (SUB-1104, SUB-1128)", () => {
  // The regression this lane exists for: `view` is spelled [Vv][Ii][Ee][Ww] in
  // the TAILED run and `heatmap` is spelled [Hh][Ee][Aa][Tt][Mm][Aa][Pp] in the
  // BARE one, on both sides. A lang run that accepts only [a-z0-9-] refuses the
  // real pattern outright ("does not match the known machine-fence shape"), so
  // the checker went red on the tree it is supposed to police.
  const { ts, rust } = collect();
  for (const side of [ts, rust]) {
    assert.ok(side.tailed.includes("view"), "tailed case pairs decode");
    assert.ok(side.bare.includes("heatmap"), "bare case pairs decode");
    for (const lang of [...side.tailed, ...side.bare, ...side.sheet]) {
      assert.match(lang, /^[a-z0-9-]+$/, `"${lang}" is decoded, not a run of case pairs`);
    }
  }
});

/* ── drift detection ────────────────────────────────────────────────────── */

test("crossCheck reports a language added to one side only", () => {
  const ts = inv("view|chart|cards|kanban", "csv|formulas");
  const rust = inv("view|chart|cards", "csv|formulas", RUST_END);
  const problems = crossCheck(ts, rust);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^tailed: src\/lib\/fences\.ts has "kanban"/);

  const back = crossCheck(rust, ts);
  assert.equal(back.length, 1);
  assert.match(back[0], /has "kanban", src\/lib\/fences\.ts does not/);
});

test("a one-sided case-folded language is named by its id, not by its case pairs", () => {
  // The drift message is what a human acts on, so a language spelled per-letter
  // has to read as `heatmap` — nobody greps the two files for
  // [Hh][Ee][Aa][Tt][Mm][Aa][Pp]. Both holes, since 1104 folds in the tailed
  // group and 1128 in the bare one.
  const bare = crossCheck(
    inv("[Vv][Ii][Ee][Ww]", "csv|[Hh][Ee][Aa][Tt][Mm][Aa][Pp]"),
    inv("[Vv][Ii][Ee][Ww]", "csv", RUST_END)
  );
  assert.equal(bare.length, 1);
  assert.match(bare[0], /^bare: src\/lib\/fences\.ts has "heatmap"/);
  assert.doesNotMatch(bare[0], /\[Hh\]/);

  const tailed = crossCheck(
    inv("[Vv][Ii][Ee][Ww]", "csv"),
    inv("[Vv][Ii][Ee][Ww]|[Cc][Hh][Aa][Rr][Tt]", "csv", RUST_END)
  );
  assert.equal(tailed.length, 1);
  assert.match(tailed[0], /^tailed: src-tauri\/src\/vault\/mod\.rs has "chart"/);
});

test("a case-fold spelled on one side only names the language (SUB-1128)", () => {
  // Same ids, same grammar: the two sides disagree only about whether ```HeatMap
  // strips. Not grammar drift (the skeleton is identical) and not a coverage gap
  // (both carry heatmap) — the decoded lists cannot see it at all, which is why
  // it gets its own finding rather than falling through to the generic "not the
  // same LIST" bucket it used to share with harmless reorders.
  const problems = crossCheck(
    inv("[Vv][Ii][Ee][Ww]", "csv|[Hh][Ee][Aa][Tt][Mm][Aa][Pp]"),
    inv("[Vv][Ii][Ee][Ww]", "csv|heatmap", RUST_END)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^bare: "heatmap" is spelled differently/);
  assert.match(problems[0], /fences\.ts case-folded .*mod\.rs plain/);
  assert.doesNotMatch(problems[0], /GRAMMAR/);
});

test("spelling drift is reported alongside list drift, not behind it (SUB-1130)", () => {
  // The three depths are independent. A merge that adds a language to one side
  // AND unfolds another's case has two problems; reporting the second only once
  // the first is fixed costs a whole extra fix-gate-push round trip.
  const problems = crossCheck(
    inv("[Vv][Ii][Ee][Ww]|kanban", "csv|[Hh][Ee][Aa][Tt][Mm][Aa][Pp]"),
    inv("[Vv][Ii][Ee][Ww]", "csv|heatmap", RUST_END)
  );
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('has "kanban"')));
  assert.ok(problems.some((p) => /"heatmap" is spelled differently/.test(p)));
});

test("a duplicate language does not also read as spelling drift", () => {
  // First spelling wins per id, so `view|view` against `view` is one finding
  // (the list difference) rather than a second, bogus, spelling disagreement.
  const problems = crossCheck(inv("view|view", "csv"), inv("view", "csv", RUST_END));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not the same LIST/);
});

test("crossCheck reports a language that changed groups on one side only", () => {
  // Same union both sides — only the tail rule moved. Left unchecked this is
  // the subtle half: ```csv raw would strip in the indexer and render as
  // searchable prose in the editor.
  const ts = inv("view|chart|cards|csv", "formulas");
  const rust = inv("view|chart|cards", "csv|formulas", RUST_END);
  const problems = crossCheck(ts, rust);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.startsWith('tailed: src/lib/fences.ts has "csv"')));
  assert.ok(problems.some((p) => p.includes('bare: src-tauri/src/vault/mod.rs has "csv"')));
});

test("crossCheck reports grammar drift while the lang lists agree", () => {
  const ts = inv("view|chart|cards", "csv|formulas");
  // A greedy body (`[\s\S]*`) reads as the same languages but swallows every
  // fence up to the LAST closer. parseFencePattern refuses that shape outright,
  // so this stands in for whatever grammar change does slip past it.
  const loosened: FenceInventory = { ...ts, pattern: ts.pattern.replace("*?", "*") };
  const problems = crossCheck(ts, loosened);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GRAMMAR differs/);
});

test("grammar drift is reported alongside list drift, not behind it", () => {
  // Both halves of a two-sided mistake in ONE pass: gating the grammar check on
  // a clean list check hid the second half until the first was fixed.
  const ts = inv("view|chart|kanban", "csv|formulas");
  const rust = inv("view|chart", "csv|formulas", RUST_END);
  const drifted: FenceInventory = { ...rust, pattern: rust.pattern.replace("*?", "*") };
  const problems = crossCheck(ts, drifted);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('has "kanban"')));
  assert.ok(problems.some((p) => /GRAMMAR differs/.test(p)));
});

test("a reorder or duplicate reads as a LIST difference, not grammar drift", () => {
  // Same languages, same grammar, different pattern text. Under the old check
  // this was reported as the opener rules having changed — a fix in the wrong
  // file.
  const ts = inv("chart|view|cards", "csv|formulas");
  const rust = inv("view|chart|cards", "csv|formulas", RUST_END);
  const reordered = crossCheck(ts, rust);
  assert.equal(reordered.length, 1);
  assert.match(reordered[0], /same languages but not the same LIST/);
  assert.doesNotMatch(reordered[0], /GRAMMAR/);
  assert.doesNotMatch(reordered[0], /spelled differently/);

  const duplicated = crossCheck(inv("view|view|chart|cards", "csv|formulas"), rust);
  assert.equal(duplicated.length, 1);
  assert.match(duplicated[0], /same languages but not the same LIST/);
});

test("crossCheck is quiet when both sides match", () => {
  assert.deepEqual(crossCheck(inv("view|chart", "csv"), inv("view|chart", "csv", RUST_END)), []);
});

/* ── the compared pattern is the one that runs ──────────────────────────── */

const TS_REL = "src/lib/fences.ts";
const RUST_REL = "src-tauri/src/vault/mod.rs";

test("both strip functions still run the pattern this checker compares (SUB-1130)", () => {
  // Without this, everything above compares two patterns that nothing has to
  // use: replacing either strip function's regex with an inline one of its own
  // left the whole suite green while the app and the indexer diverged.
  assert.deepEqual(checkUseSites(readSources()), []);
});

test("a strip function that stops delegating is reported, per side (SUB-1130)", () => {
  const src = readSources();
  const tsOnly = {
    ...src,
    [TS_REL]: src[TS_REL].replace(
      "body.replace(MACHINE_FENCE_RE,",
      "body.replace(/```view\\r?\\n[\\s\\S]*?(?:```|$)/g,"
    ),
  };
  assert.notEqual(tsOnly[TS_REL], src[TS_REL], "the TS mutation anchor still exists");
  const tsProblems = checkUseSites(tsOnly);
  assert.equal(tsProblems.length, 1);
  assert.match(tsProblems[0], /^src\/lib\/fences\.ts: the strip function no longer runs/);

  const rustOnly = {
    ...src,
    [RUST_REL]: src[RUST_REL].replace(
      "fn strip_machine_fences(body: &str) -> String {\n    machine_fence_re()",
      'fn strip_machine_fences(body: &str) -> String {\n    Regex::new(r"```view").unwrap()'
    ),
  };
  assert.notEqual(rustOnly[RUST_REL], src[RUST_REL], "the Rust mutation anchor still exists");
  const rustProblems = checkUseSites(rustOnly);
  assert.equal(rustProblems.length, 2, "no longer delegates, and builds its own");
  assert.ok(rustProblems.some((p) => /no longer runs machine_fence_re\(\)/.test(p)));
  assert.ok(rustProblems.some((p) => /builds a regex of its own/.test(p)));
});

test("a doc comment naming the pattern does not stand in for using it", () => {
  // The check runs on the comment-blanked source, so prose about
  // MACHINE_FENCE_RE neither satisfies the delegation rule nor trips the
  // no-second-regex one.
  const src = readSources();
  const commented = {
    ...src,
    [TS_REL]: src[TS_REL].replace(
      "body.replace(MACHINE_FENCE_RE,",
      "body.replace(/x/g, /* MACHINE_FENCE_RE lives here */"
    ),
  };
  assert.notEqual(commented[TS_REL], src[TS_REL], "anchor still exists");
  assert.match(checkUseSites(commented)[0] ?? "", /no longer runs MACHINE_FENCE_RE/);
});

test("checkUseSites throws when a strip function cannot be found", () => {
  // A renamed function is this checker being wrong about the tree, not the tree
  // being wrong — different fix, so it must not read as clean OR as drift.
  const src = readSources();
  assert.throws(
    () =>
      checkUseSites({
        ...src,
        [RUST_REL]: src[RUST_REL].replace("fn strip_machine_fences(", "fn strip_fences_v2("),
      }),
    /was not found — it moved or was renamed/
  );
});

/* ── the guard bites: one-sided edits to the real patterns ──────────────── */

/**
 * Every mutation is a single one-sided edit to the CHECKED-IN Rust pattern, run
 * through the same parse-and-compare path the checker uses. The tests above all
 * feed hand-built inventories, so a refactor that made `collect()` compare a
 * side against itself — or widened SHAPE until it matched anything — would leave
 * every one of them green. These fail if the guard stops biting.
 *
 * `throws` is the honest expectation for a grammar edit: the pattern stops being
 * the known shape, and the checker refuses to read past it rather than compare
 * two things it no longer understands (exit 2, not exit 1 — both are red). An
 * edit to the closing alternative is refused one step earlier, by
 * `normalizeEnd` — same red, a different sentence, so `throws` accepts either.
 */
const ONE_SIDED_EDITS: { name: string; from: string; to: string; expect: RegExp | "throws" }[] = [
  {
    name: "a language added to the tailed group",
    from: "|[Kk][Ii][Nn][Dd])",
    to: "|[Kk][Ii][Nn][Dd]|[Tt][Aa][Bb][Ll][Ee])",
    expect: /tailed: src-tauri\/src\/vault\/mod\.rs has "table"/,
  },
  {
    name: "a language moved from the tailed group to the bare one",
    from: "|[Kk][Ii][Nn][Dd])(?:[ \\t][^`\\n]*)?|(?:[Hh]",
    to: ")(?:[ \\t][^`\\n]*)?|(?:[Kk][Ii][Nn][Dd]|[Hh]",
    expect: /tailed: src\/lib\/fences\.ts has "kind"/,
  },
  {
    // csv sits in the sheet group now, and its parser matches the literal
    // opener — a fold on one side only means ```CSV strips there while it is
    // an ordinary code box, and searchable prose, everywhere else
    name: "a case fold added to a sheet-pair language",
    from: "csv|formulas",
    to: "[Cc][Ss][Vv]|formulas",
    expect: /sheet: "csv" is spelled differently/,
  },
  {
    name: "a case fold removed from heatmap",
    from: "[Hh][Ee][Aa][Tt][Mm][Aa][Pp]",
    to: "heatmap",
    expect: /bare: "heatmap" is spelled differently/,
  },
  {
    name: "the lang run reordered",
    from: "[Vv][Ii][Ee][Ww]|[Cc][Hh][Aa][Rr][Tt]|",
    to: "[Cc][Hh][Aa][Rr][Tt]|[Vv][Ii][Ee][Ww]|",
    expect: /not the same LIST/,
  },
  { name: "the CRLF opener dropped (SUB-913)", from: ")\\r?\\n", to: ")\\n", expect: "throws" },
  {
    // a ~~~view fence draws live in the editor exactly like the backtick
    // spelling, so a side that goes back to backtick-only leaks its config
    // into the search index while the other side strips it
    name: "the tilde opener dropped from the marker alternation (SUB-1703)",
    from: "(?:```|~~~)[ \\t]*(?:(?:[Vv]",
    to: "```[ \\t]*(?:(?:[Vv]",
    expect: "throws",
  },
  {
    name: "the tilde closer dropped from the body's end alternative (SUB-1703)",
    from: "[\\s\\S]*?(?:```|~~~|\\z)",
    to: "[\\s\\S]*?(?:```|\\z)",
    expect: "throws",
  },
  {
    // a bare-form opener typed with a stray space renders the live board, so
    // one side dropping the allowance means that board's config lands back in
    // the search index while the other side strips it
    name: "the bare group's trailing-whitespace allowance dropped",
    from: "[Tt][Ii][Mm][Ee][Ll][Ii][Nn][Ee])[ \\t]*)",
    to: "[Tt][Ii][Mm][Ee][Ll][Ii][Nn][Ee]))",
    expect: "throws",
  },
  {
    // ```csv␠ is the bare opener with a stray space and both sheet parsers
    // read it as one, so the sheet branch keeps the allowance the marker and
    // space-before rules stop short of
    name: "the sheet branch's trailing-whitespace allowance dropped (SUB-1703)",
    from: "|```(?:csv|formulas)[ \\t]*)",
    to: "|```(?:csv|formulas))",
    expect: "throws",
  },
  {
    // no parser in the app reads ~~~csv — a side that lets the sheet pair ride
    // the marker alternation drops a user's own tilde fence out of search with
    // no leak closed anywhere
    name: "the sheet branch given the tilde marker (SUB-1703)",
    from: "|```(?:csv",
    to: "|(?:```|~~~)(?:csv",
    expect: "throws",
  },
  {
    // findFence matches the literal "```csv", so ``` csv is prose to the sheet
    // — the same one-sided over-strip in the other spelling
    name: "the sheet branch given the space-before-info allowance (SUB-1703)",
    from: "|```(?:csv",
    to: "|```[ \\t]*(?:csv",
    expect: "throws",
  },
  {
    // "``` view" names the language `view` to CommonMark, to lezer and to the
    // block scanner, so a side that goes back to lang-hugs-the-marker leaves
    // that widget's config in the search index while the other side strips it
    name: "the space-before-info allowance dropped from the opener",
    from: "(?:```|~~~)[ \\t]*(?:(?:[Vv]",
    to: "(?:```|~~~)(?:(?:[Vv]",
    expect: "throws",
  },
  {
    name: "the backtick guard dropped from the tail (SUB-983)",
    from: "[ \\t][^`\\n]*",
    to: "[ \\t][^\\n]*",
    expect: "throws",
  },
  {
    name: "the body made greedy",
    from: "[\\s\\S]*?(?:```|~~~|\\z)",
    to: "[\\s\\S]*(?:```|~~~|\\z)",
    expect: "throws",
  },
];

for (const edit of ONE_SIDED_EDITS) {
  test(`the guard bites: ${edit.name}`, () => {
    const { ts, rust } = collect();
    // parseFencePattern is fed the raw dialect spelling back, so the mutated
    // pattern goes through exactly the path collect() puts the real one on.
    const raw = rust.pattern.replace("(?:```|~~~|<END-OF-INPUT>)", "(?:```|~~~|\\z)");
    assert.equal(
      raw.split(edit.from).length - 1,
      1,
      `the mutation anchor "${edit.from}" appears exactly once in the Rust pattern`
    );
    const mutate = () => parseFencePattern(raw.replace(edit.from, edit.to), "mutated");
    if (edit.expect === "throws") {
      assert.throws(
        mutate,
        /does not match the known machine-fence shape|does not end in an end-of-input alternative/
      );
      return;
    }
    const problems = crossCheck(ts, mutate());
    assert.ok(problems.length > 0, "one-sided edit is reported");
    assert.ok(
      problems.some((p) => (edit.expect as RegExp).test(p)),
      `expected ${edit.expect} in:\n${problems.join("\n")}`
    );
  });
}

test("the mutation table is comparing against a clean tree", () => {
  // Every case above asserts a MUTATED pattern goes red; without this they
  // would all still pass if the checked-in tree were red to begin with.
  const { ts, rust } = collect();
  assert.deepEqual(crossCheck(ts, rust), []);
  assert.equal(ts.pattern, rust.pattern, "the two sides are character-identical once normalized");
});

/* ── parsers refuse what they cannot read ───────────────────────────────── */

test("normalizeEnd accepts either dialect's end-of-input and rejects others", () => {
  const js = normalizeEnd(pattern("view", "csv", JS_END), "js");
  const rust = normalizeEnd(pattern("view", "csv", RUST_END), "rust");
  assert.equal(js, rust, "the dialect difference is normalized away");
  assert.throws(
    () => normalizeEnd("```(?:view)\\n[\\s\\S]*?```", "x"),
    /does not end in an end-of-input alternative/
  );
});

test("parseFencePattern throws on an unknown pattern shape", () => {
  // Losing the backtick guard from the tail is a real grammar change
  // and must stop the checker rather than be read past.
  assert.throws(
    () => parseFencePattern("```(?:(?:view)(?:[ \\t][^\\n]*)?|csv)\\r?\\n[\\s\\S]*?" + JS_END, "x"),
    /does not match the known machine-fence shape/
  );
  assert.throws(() => parseFencePattern("nothing like a fence" + JS_END, "x"), /shape/);
});

test("parseRustPattern lifts the regex out of machine_fence_re", () => {
  const src = [
    "// fn machine_fence_re is mentioned in this comment first",
    "fn machine_fence_re() -> &'static Regex {",
    "    static RE: OnceLock<Regex> = OnceLock::new();",
    '    RE.get_or_init(|| Regex::new(r"```(?:view)\\r?\\n[\\s\\S]*?(?:```|\\z)").unwrap())',
    "}",
    "fn other() { let s = r\"decoy\"; }",
  ].join("\n");
  assert.equal(parseRustPattern(src, "fake.rs"), "```(?:view)\\r?\\n[\\s\\S]*?(?:```|\\z)");
});

test("an r\"…\" inside a comment in the body is not counted as a second pattern", () => {
  // The scan runs on the blanked body, so this stays at one literal. Reading
  // the raw source instead made a commented-out pattern throw "found 2".
  const src = [
    "fn machine_fence_re() -> &'static Regex {",
    '    // was: Regex::new(r"```(?:view)\\r?\\n[\\s\\S]*?(?:```|\\z)")',
    '    Regex::new(r"```(?:view|chart)\\r?\\n[\\s\\S]*?(?:```|\\z)").unwrap()',
    "}",
  ].join("\n");
  assert.equal(parseRustPattern(src, "fake.rs"), "```(?:view|chart)\\r?\\n[\\s\\S]*?(?:```|\\z)");
});

test("a RegexBuilder is refused — it can set flags the pattern text never shows", () => {
  const src = [
    "fn machine_fence_re() -> &'static Regex {",
    '    RegexBuilder::new(r"```(?:view)\\r?\\n[\\s\\S]*?(?:```|\\z)")',
    "        .case_insensitive(true)",
    "        .build()",
    "        .unwrap()",
    "}",
  ].join("\n");
  assert.throws(() => parseRustPattern(src, "fake.rs"), /bare Regex::new/);
});

test("the checked-in TS regex carries no flags beyond /g", () => {
  // collect() refuses anything else: `i`, `m` and `s` each change what the same
  // pattern text matches, and the Rust side has no flag to drift with it.
  assert.equal(MACHINE_FENCE_RE.flags, "g");
});

test("a hashed raw string is read whole, quotes in the pattern and all", () => {
  // blankNonCode now lexes r#"…"#, so the hashed form — the one a pattern
  // containing a bare `"` has to use — is read rather than half-compared.
  const src = 'fn machine_fence_re() {\n    Regex::new(r#"a"b"#).unwrap()\n}';
  assert.equal(parseRustPattern(src, "fake.rs"), 'a"b');
});

test("parseRustPattern throws rather than guessing", () => {
  assert.throws(() => parseRustPattern("fn other() {}", "fake.rs"), /not found/);
  assert.throws(
    () => parseRustPattern('fn machine_fence_re() {\n    join(r"a", r"b")\n}', "fake.rs"),
    /exactly one raw-string regex .*found 2/
  );
  assert.throws(
    () => parseRustPattern("fn machine_fence_re() {\n    none()\n}", "fake.rs"),
    /found 0/
  );
});
