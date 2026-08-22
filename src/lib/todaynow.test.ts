import { test } from "node:test";
import assert from "node:assert/strict";
import { clockKey, nowNextCursor, untilLabel } from "./todaynow.ts";
import type { ClockEntry } from "./todaynow.ts";

const DAY = "2026-08-22";

function e(name: string, time?: string, extra: Partial<ClockEntry> = {}): ClockEntry {
  return { path: `${name}.md`, prop: "date", day: DAY, time, ...extra };
}

test("no clock reading yields no cursor", () => {
  assert.deepEqual(nowNextCursor([e("call", "09:00")], null), {
    now: null,
    next: null,
    untilMin: null,
  });
});

test("all-day entries never answer now or next", () => {
  assert.deepEqual(nowNextCursor([e("trip"), e("birthday")], 600), {
    now: null,
    next: null,
    untilMin: null,
  });
});

test("the earliest future entry is next, with the minutes until it", () => {
  const cursor = nowNextCursor([e("late", "18:00"), e("soon", "10:30")], 600);
  assert.equal(cursor.next, clockKey(e("soon", "10:30")));
  assert.equal(cursor.untilMin, 30);
  assert.equal(cursor.now, null);
});

test("an end-less entry is now for its default hour, then stops", () => {
  const entries = [e("standup", "09:00")];
  assert.equal(nowNextCursor(entries, 9 * 60 + 30).now, clockKey(entries[0]));
  assert.equal(nowNextCursor(entries, 10 * 60).now, null);
});

test("the next entry's start ends the previous one's claim on now", () => {
  const entries = [e("standup", "09:00"), e("review", "09:20")];
  const at = (min: number) => nowNextCursor(entries, min).now;
  assert.equal(at(9 * 60 + 10), clockKey(entries[0]));
  assert.equal(at(9 * 60 + 25), clockKey(entries[1]));
});

test("an explicit end time holds the entry as now for its whole length", () => {
  const entries = [e("session", "14:00", { endTime: "17:00" })];
  assert.equal(nowNextCursor(entries, 16 * 60 + 45).now, clockKey(entries[0]));
  assert.equal(nowNextCursor(entries, 17 * 60 + 1).now, null);
});

test("an entry running past midnight stays now to the end of the day", () => {
  const entries = [e("gig", "22:00", { endDay: "2026-08-23", endTime: "03:00" })];
  assert.equal(nowNextCursor(entries, 23 * 60 + 50).now, clockKey(entries[0]));
});

test("the last thing to start is the one you are inside", () => {
  const entries = [
    e("long", "09:00", { endTime: "12:00" }),
    e("short", "10:00", { endTime: "11:00" }),
  ];
  assert.equal(nowNextCursor(entries, 10 * 60 + 30).now, clockKey(entries[1]));
});

test("nothing left today leaves next empty", () => {
  const cursor = nowNextCursor([e("done", "08:00")], 20 * 60);
  assert.equal(cursor.next, null);
  assert.equal(cursor.untilMin, null);
});

test("the countdown reads in minutes, then hours", () => {
  assert.equal(untilLabel(0), "now");
  assert.equal(untilLabel(25), "in 25m");
  assert.equal(untilLabel(120), "in 2h");
  assert.equal(untilLabel(130), "in 2h 10m");
});
