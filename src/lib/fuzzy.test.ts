import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_MATCH, fuzzyScore } from "./fuzzy.ts";

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
