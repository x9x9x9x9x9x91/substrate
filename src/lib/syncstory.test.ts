import { test } from "node:test";
import assert from "node:assert/strict";
import { ageMs, ago, findingSentence, fmtAge } from "./syncstory.ts";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("ageMs: null on absent or unparseable input", () => {
  assert.equal(ageMs(undefined, NOW), null);
  assert.equal(ageMs("not-a-date", NOW), null);
  assert.equal(ageMs(iso(60_000), NOW), 60_000);
});

test("fmtAge: the sync surface's age voice", () => {
  assert.equal(fmtAge(undefined, NOW), "never");
  assert.equal(fmtAge(iso(0), NOW), "0m");
  assert.equal(fmtAge(iso(35 * 60_000), NOW), "35m");
  assert.equal(fmtAge(iso(59 * 60_000 + 59_000), NOW), "59m");
  assert.equal(fmtAge(iso(60 * 60_000), NOW), "1h");
  assert.equal(fmtAge(iso(90 * 60_000), NOW), "1h 30m");
  assert.equal(fmtAge(iso(2 * 3_600_000 + 14 * 60_000), NOW), "2h 14m");
  // a future stamp floors at 0m rather than going negative
  assert.equal(fmtAge(iso(-60_000), NOW), "0m");
});

test("fmtAge: two largest units, zero remainders dropped (SUB-693)", () => {
  // whole hours lose the "0m" tail
  assert.equal(fmtAge(iso(9 * 3_600_000), NOW), "9h");
  // days start at 24h, not 48h — 26h reads as a day and change
  assert.equal(fmtAge(iso(24 * 3_600_000), NOW), "1d");
  assert.equal(fmtAge(iso(26 * 3_600_000), NOW), "1d 2h");
  assert.equal(fmtAge(iso(47 * 3_600_000), NOW), "1d 23h");
  assert.equal(fmtAge(iso(48 * 3_600_000), NOW), "2d");
  assert.equal(fmtAge(iso(50 * 3_600_000), NOW), "2d 2h");
});

test("ago: wraps the age, passes 'never' through bare", () => {
  assert.equal(ago(iso(35 * 60_000), NOW), "35m ago");
  assert.equal(ago(undefined, NOW), "never");
});

test("findingSentence: the full problem-row story", () => {
  assert.equal(
    findingSentence("failed", 2, iso(35 * 60_000), NOW),
    "failed · 2 errors · tried 35m ago"
  );
  // singular error count
  assert.equal(
    findingSentence("failed", 1, iso(35 * 60_000), NOW),
    "failed · 1 error · tried 35m ago"
  );
});

test("findingSentence: parts drop out when the state file doesn't carry them", () => {
  // zero/absent errors are not a finding detail
  assert.equal(findingSentence("failed", 0, iso(35 * 60_000), NOW), "failed · tried 35m ago");
  assert.equal(findingSentence("failed", undefined, iso(35 * 60_000), NOW), "failed · tried 35m ago");
  // no attempt on record: no "tried never ago" — the clause drops
  assert.equal(findingSentence("failed", 2), "failed · 2 errors");
  // a bare status is still a story (e.g. blocked-mass-delete with no fields)
  assert.equal(findingSentence("blocked-mass-delete"), "blocked-mass-delete");
  assert.equal(findingSentence("missing-local", 3), "missing-local · 3 errors");
});
