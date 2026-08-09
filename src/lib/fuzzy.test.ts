import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_MATCH, fuzzyMatchRuns, fuzzyScore } from "./fuzzy.ts";

test("non-BMP chars match by code point (SUB-236)", () => {
  // 🛒 is a surrogate pair — UTF-16 unit scanning never matched it
  assert.ok(fuzzyScore("🛒shop", "🛒 Shopping List") > -1);
  assert.ok(fuzzyScore("🛒", "my 🛒 list") > -1);
});

test("empty query matches everything", () => {
  assert.equal(fuzzyScore("", "anything"), 1);
});

test("prefix beats substring beats subsequence", () => {
  const prefix = fuzzyScore("shop", "shopping list");
  const substring = fuzzyScore("shop", "the shop list");
  const subsequence = fuzzyScore("shop", "so happy people");
  assert.ok(prefix > substring, `${prefix} should beat ${substring}`);
  assert.ok(substring > subsequence, `${substring} should beat ${subsequence}`);
  assert.ok(subsequence > -1);
});

test("no match scores -1", () => {
  assert.equal(fuzzyScore("xyz", "shopping list"), NO_MATCH);
});

/**
 * The streak bonus asked whether the target char before this match
 * appears ANYWHERE in the query, which is true by accident whenever a query
 * letter repeats in the target — so matches pages apart collected a
 * contiguity bonus. It must key off adjacency to the previous match instead.
 */
test("streak bonus needs adjacency, not membership (SUB-1016)", () => {
  // both targets match "abc" at the same indices 0/2/4; they differ only in
  // the char sitting before the "c" — "a" is a query letter, "z" is not, and
  // neither match is adjacent, so neither may earn a bonus
  assert.equal(
    fuzzyScore("abc", "azbac"),
    fuzzyScore("abc", "azbzc"),
    "a repeated query letter before the match must not buy a streak bonus",
  );
});

test("a genuinely contiguous run still pays (SUB-1016)", () => {
  // "azbcd": one run of three (b-c-d). "abzcd": two runs of two (a-b, c-d).
  // Same length, same query — the longer contiguous run must win.
  const oneLongRun = fuzzyScore("abcd", "azbcd");
  const twoShortRuns = fuzzyScore("abcd", "abzcd");
  assert.ok(oneLongRun > twoShortRuns, `${oneLongRun} should beat ${twoShortRuns}`);
});

/**
 * The subsequence branch charges 0.2 per character of position, so a
 * real match late in a long label sums negative. It stays a match — callers
 * drop candidates on the sentinel alone, never on sign.
 */
test("a late match in a long label is weak, not a miss (SUB-1016)", () => {
  const long = "Spectral Granular Synthesis Notes from the Berlin Studio Session — Workflow Quirks";
  const late = fuzzyScore("wq", long);
  assert.notEqual(late, NO_MATCH, "the query threads through the label — it is a match");
  assert.ok(late > NO_MATCH, `${late} must stay clear of the ${NO_MATCH} sentinel`);
  assert.ok(late < fuzzyScore("spectral", long), "but it ranks below a prefix match");
});

/**
 * The palette marks WHY a row matched. fuzzyMatchRuns must agree
 * with fuzzyScore on WHETHER the query matches, and return sliceable UTF-16
 * ranges for where.
 */
test("match runs: substring hit is one run over the original casing (SUB-1205)", () => {
  const runs = fuzzyMatchRuns("mast", "Master Vessel Songs v3");
  assert.deepEqual(runs, [{ start: 0, end: 4 }]);
});

test("match runs: subsequence hit merges adjacent chars into runs (SUB-1205)", () => {
  // "svs" through "Vessel Songs v3": s(2? no —) greedy first occurrences
  const runs = fuzzyMatchRuns("sv", "Slow Bloom EP v2");
  assert.ok(runs && runs.length >= 1);
  const text = "Slow Bloom EP v2";
  const matched = runs!.map((r) => text.slice(r.start, r.end)).join("");
  assert.equal(matched.toLowerCase(), "sv");
});

test("match runs: no thread → null, empty query → null (SUB-1205)", () => {
  assert.equal(fuzzyMatchRuns("xyz", "shopping list"), null);
  assert.equal(fuzzyMatchRuns("", "anything"), null);
});

test("match runs: surrogate pairs keep indices exact (SUB-1205)", () => {
  const target = "my 🛒 list";
  const runs = fuzzyMatchRuns("🛒l", target);
  assert.ok(runs, "emoji query must thread");
  const matched = runs!.map((r) => target.slice(r.start, r.end)).join("");
  assert.equal(matched.toLowerCase(), "🛒l");
});

test("match runs agree with fuzzyScore on match/no-match (SUB-1205)", () => {
  const cases: [string, string][] = [
    ["shop", "shopping list"],
    ["shop", "the shop list"],
    ["shop", "so happy people"],
    ["xyz", "shopping list"],
    ["🛒shop", "🛒 Shopping List"],
    ["wq", "Spectral Granular Synthesis Notes from the Berlin Studio Session — Workflow Quirks"],
  ];
  for (const [q, t] of cases) {
    const scored = fuzzyScore(q, t) > NO_MATCH;
    const runs = fuzzyMatchRuns(q, t) !== null;
    assert.equal(runs, scored, `"${q}" vs "${t}": runs ${runs} but score-match ${scored}`);
  }
});
