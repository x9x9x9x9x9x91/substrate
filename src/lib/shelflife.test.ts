import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ageLabel,
  canonicalReviewWindow,
  pastWindow,
  rankShelfReadings,
  reviewWindowDays,
  shelfReading,
  windowLabel,
} from "./shelflife.ts";
import type { FactFreshness } from "./types.ts";

const NOW = Date.UTC(2026, 7, 18);
const DAY = 86_400_000;

function fresh(daysAgo: number | null, over: Partial<FactFreshness> = {}): FactFreshness {
  return {
    path: "Contacts/Ada.md",
    key: "phone",
    reviewed_ts_ms: daysAgo === null ? null : NOW - daysAgo * DAY,
    reviewed_commit: daysAgo === null ? null : "c1",
    reviewed_actor: daysAgo === null ? null : { kind: "app" },
    only_bulk: false,
    oldest_ts_ms: NOW - 3000 * DAY,
    ...over,
  };
}

test("a window reads the same however it was typed", () => {
  assert.equal(canonicalReviewWindow("Yearly"), "1y");
  assert.equal(canonicalReviewWindow("quarterly"), "3m");
  assert.equal(canonicalReviewWindow(" 90D "), "90d");
  assert.equal(reviewWindowDays("yearly"), 365);
  assert.equal(reviewWindowDays("3m"), 90);
  assert.equal(reviewWindowDays("2w"), 14);
  // and a window nothing can read stays unread rather than guessed at
  // the multibyte cases are the engine's parity check: `canonical_review_window`
  // splits off the last CHARACTER, so both sides reject these rather than one
  // rejecting and the other cutting a character in half
  for (const bad of [
    "",
    "d",
    "90",
    "90 days",
    "0d",
    "1000d",
    "fortnightly",
    "90€",
    "90д",
    "🙂",
    null,
    undefined,
  ])
    assert.equal(canonicalReviewWindow(bad), null, `${bad} names no window`);
  assert.equal(reviewWindowDays("whenever"), null);
});

test("a value is fresh, then aging, then due against its own window", () => {
  const w = "90d";
  assert.equal(shelfReading(fresh(10), w, NOW).state, "fresh");
  // three quarters through is where the tint turns
  assert.equal(shelfReading(fresh(67), w, NOW).state, "fresh");
  assert.equal(shelfReading(fresh(68), w, NOW).state, "aging");
  assert.equal(shelfReading(fresh(89), w, NOW).state, "aging");
  assert.equal(shelfReading(fresh(90), w, NOW).state, "due");
  const late = shelfReading(fresh(120), w, NOW);
  assert.equal(late.overdueDays, 30);
  assert.equal(late.windowDays, 90);
  // a few hours old is today, never a day
  assert.equal(shelfReading(fresh(0), w, NOW).ageDays, 0);
});

test("a value with no window has an age and nothing to be late for", () => {
  const r = shelfReading(fresh(400), null, NOW);
  assert.equal(r.state, "unwindowed");
  assert.equal(r.ageDays, 400);
  assert.equal(r.overdueDays, null);
  assert.equal(r.ratio, null);
});

test("a fact no person ever set has an unknown age, not a fresh one", () => {
  // the sweep case: an import rewrote it, nobody has looked since
  const r = shelfReading(fresh(null, { only_bulk: true }), "90d", NOW);
  assert.equal(r.state, "unknown");
  assert.equal(r.ageDays, null);
  assert.equal(r.onlyBulk, true);
  // and a fact with no history at all reads unknown too, saying which it is
  assert.equal(shelfReading(fresh(null), "90d", NOW).onlyBulk, false);
});

test("the report ranks the furthest past its window first", () => {
  const r = (key: string, days: number, window: string) =>
    shelfReading(fresh(days, { key }), window, NOW);
  const ranked = pastWindow([
    r("aging", 80, "90d"), // 0.89 of its window
    r("late", 200, "90d"), // 2.2×
    r("worse", 400, "90d"), // 4.4×
    r("yearly-late", 400, "1y"), // 1.1×
  ]);
  assert.deepEqual(
    ranked.map((x) => x.key),
    ["worse", "late", "yearly-late", "aging"]
  );
  // an unwindowed value is not a finding — nobody said it goes off — and
  // neither is one nobody can date
  assert.deepEqual(pastWindow([shelfReading(fresh(4000), null, NOW)]), []);
  assert.deepEqual(pastWindow([shelfReading(fresh(null), "1d", NOW)]), []);
});

test("ranking is stable on ties so the same vault reads the same way", () => {
  const a = shelfReading(fresh(100, { path: "B.md", key: "x" }), "90d", NOW);
  const b = shelfReading(fresh(100, { path: "A.md", key: "x" }), "90d", NOW);
  assert.deepEqual(
    rankShelfReadings([a, b]).map((x) => x.path),
    ["A.md", "B.md"]
  );
});

test("ages and windows read as a person would say them", () => {
  assert.equal(ageLabel(0), "today");
  assert.equal(ageLabel(1), "yesterday");
  assert.equal(ageLabel(9), "9 days");
  assert.equal(ageLabel(21), "3 weeks");
  assert.equal(ageLabel(200), "6 months");
  assert.equal(ageLabel(800), "2 years");
  assert.equal(ageLabel(null), "unknown");
  assert.equal(windowLabel("1y"), "yearly");
  assert.equal(windowLabel("90d"), "every 90 days");
  assert.equal(windowLabel("1d"), "every 1 day");
  assert.equal(windowLabel("nonsense"), null);
});
