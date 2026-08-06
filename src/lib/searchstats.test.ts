import { test } from "node:test";
import assert from "node:assert/strict";
import { resultUnit, searchStats, type SearchStatsInput } from "./searchstats.ts";

const base: SearchStatsInput = {
  searching: true,
  filtered: false,
  groups: 12,
  matches: 30,
  total: 12,
  truncated: false,
  pageHasMountRow: false,
  vaultHasMounts: false,
};

test("resultUnit calls a pure-note count notes, singular included", () => {
  assert.equal(resultUnit(4, false), "notes");
  assert.equal(resultUnit(1, false), "note");
});

test("resultUnit calls a count that can hold files results", () => {
  assert.equal(resultUnit(4, true), "results");
  assert.equal(resultUnit(1, true), "result");
});

test("searchStats says nothing without a query or a filter", () => {
  assert.equal(searchStats({ ...base, searching: false }), "");
});

test("searchStats counts what an operator-only filter kept", () => {
  assert.equal(searchStats({ ...base, searching: false, filtered: true, groups: 3 }), "3 notes");
});

test("searchStats reports a whole page as matches in notes", () => {
  assert.equal(searchStats({ ...base, groups: 12, matches: 30 }), "30 matches in 12 notes");
});

test("searchStats reports a truncated page as a page, not a total of matches", () => {
  assert.equal(
    searchStats({ ...base, groups: 200, total: 3412, truncated: true }),
    "first 200 of 3412 notes"
  );
});

test("searchStats calls a page holding a mounted file results", () => {
  assert.equal(
    searchStats({ ...base, groups: 12, matches: 30, pageHasMountRow: true }),
    "30 matches in 12 results"
  );
});

// the engine's total counts mount rows, so a vault with a mount cannot promise
// the number behind a truncated page is notes — even when every row that did
// fit is one
test("searchStats calls the engine's total results whenever the vault has a mount", () => {
  assert.equal(
    searchStats({
      ...base,
      groups: 200,
      total: 3412,
      truncated: true,
      pageHasMountRow: false,
      vaultHasMounts: true,
    }),
    "first 200 of 3412 results"
  );
});

test("searchStats leaves the page's own word alone when only the total is mixed", () => {
  assert.equal(
    searchStats({ ...base, groups: 12, matches: 30, vaultHasMounts: true }),
    "30 matches in 12 notes"
  );
});

test("searchStats keeps every singular singular", () => {
  assert.equal(searchStats({ ...base, groups: 1, matches: 1 }), "1 match in 1 note");
  assert.equal(
    searchStats({ ...base, groups: 1, total: 1, truncated: true, vaultHasMounts: true }),
    "first 1 of 1 result"
  );
});
