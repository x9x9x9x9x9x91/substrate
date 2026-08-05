import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collect,
  crossCheck,
  normalizeEnd,
  parseFencePattern,
  parseRustPattern,
  type FenceInventory,
} from "./check-fence-langs.ts";
import {
  BARE_MACHINE_FENCE_LANGS,
  MACHINE_FENCE_RE,
  TAILED_MACHINE_FENCE_LANGS,
} from "../src/lib/fences.ts";

const JS_END = "(?:```|$)";
const RUST_END = "(?:```|\\z)";

/** A machine-fence pattern in the current grammar, for the given lang groups. */
const pattern = (tailed: string, bare: string, end: string) =>
  "```(?:(?:" + tailed + ")(?:[ \\t][^`\\n]*)?|" + bare + ")\\r?\\n[\\s\\S]*?" + end;

const inv = (tailed: string, bare: string, end = JS_END): FenceInventory =>
  parseFencePattern(pattern(tailed, bare, end), "test");

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
    assert.deepEqual(side.bare, [...BARE_MACHINE_FENCE_LANGS]);
  }
  assert.ok(ts.tailed.length > 0 && ts.bare.length > 0, "neither group is empty");
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
    for (const lang of [...side.tailed, ...side.bare]) {
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

test("a case-fold spelled on one side only reads as a LIST difference", () => {
  // Same ids, same grammar: the two sides disagree only about whether ```HeatMap
  // strips. Not grammar drift (the skeleton is identical) and not a coverage
  // gap (both carry heatmap), so it lands in the list bucket — whose message
  // names case-folding as a cause and prints both patterns to compare.
  const problems = crossCheck(
    inv("[Vv][Ii][Ee][Ww]", "csv|[Hh][Ee][Aa][Tt][Mm][Aa][Pp]"),
    inv("[Vv][Ii][Ee][Ww]", "csv|heatmap", RUST_END)
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /same languages but not the same LIST/);
  assert.match(problems[0], /case-fold spelled on one side only/);
  assert.doesNotMatch(problems[0], /GRAMMAR/);
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

  const duplicated = crossCheck(inv("view|view|chart|cards", "csv|formulas"), rust);
  assert.equal(duplicated.length, 1);
  assert.match(duplicated[0], /same languages but not the same LIST/);
});

test("crossCheck is quiet when both sides match", () => {
  assert.deepEqual(crossCheck(inv("view|chart", "csv"), inv("view|chart", "csv", RUST_END)), []);
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
  // Losing the backtick guard from the tail (SUB-983) is a real grammar change
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

test("a hashed raw string fails loudly rather than being misread", () => {
  // blankNonCode (shared with check-ipc) knows plain Rust strings only, so
  // rewriting the regex as r#"…"# stops the checker with a parse error instead
  // of quietly comparing half a pattern. Loud is the contract; if the Rust side
  // ever needs the hashed form, teach blankNonCode first.
  const src = 'fn machine_fence_re() {\n    Regex::new(r#"a"b"#).unwrap()\n}';
  assert.throws(() => parseRustPattern(src, "fake.rs"));
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
