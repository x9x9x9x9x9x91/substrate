import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysAgoIso,
  daysBetween,
  durationFrom,
  formatDateHuman,
  isIsoDate,
  monthGrid,
  msUntilNextMidnight,
  parseDateLoose,
  parseDateTimeLoose,
  shiftDate,
  todayIso,
  toIso,
} from "./dates.ts";

test("isIsoDate accepts real dates only", () => {
  assert.ok(isIsoDate("2026-07-17"));
  assert.ok(isIsoDate("2024-02-29"), "leap day");
  assert.ok(!isIsoDate("2025-02-29"), "not a leap year");
  assert.ok(!isIsoDate("2026-13-01"));
  assert.ok(!isIsoDate("2026-00-10"));
  assert.ok(!isIsoDate("2026-7-1"), "unpadded is not ISO");
  assert.ok(!isIsoDate("in review"));
  assert.ok(!isIsoDate("2026-07-17T10:00"));
});

test("formatDateHuman renders ISO, passes junk through", () => {
  assert.equal(formatDateHuman("2026-07-17"), "Jul 17, 2026");
  assert.equal(formatDateHuman("2026-01-02"), "Jan 2, 2026");
  assert.equal(formatDateHuman("soonish"), "soonish");
});

test("parseDateLoose: ISO passthrough, engine fallback, junk null", () => {
  assert.equal(parseDateLoose("2026-07-17"), "2026-07-17");
  assert.equal(parseDateLoose("  2026-07-17  "), "2026-07-17");
  assert.equal(parseDateLoose("Jul 17 2026"), "2026-07-17");
  assert.equal(parseDateLoose("total junk :::"), null);
  assert.equal(parseDateLoose(""), null);
});

test("parseDateLoose: month-name forms default to the current year (SUB-228)", () => {
  const y = new Date().getFullYear();
  assert.equal(parseDateLoose("jul 17"), `${y}-07-17`);
  assert.equal(parseDateLoose("Jul 17"), `${y}-07-17`);
  assert.equal(parseDateLoose("july 17"), `${y}-07-17`);
  assert.equal(parseDateLoose("july 3"), `${y}-07-03`);
  assert.equal(parseDateLoose("17 jul"), `${y}-07-17`);
  assert.equal(parseDateLoose("17 July"), `${y}-07-17`);
  assert.equal(parseDateLoose("sept 5"), `${y}-09-05`, "3+-letter prefix");
  assert.equal(parseDateLoose("jul 17 2026"), "2026-07-17");
  assert.equal(parseDateLoose("17 jul 2026"), "2026-07-17");
  assert.equal(parseDateLoose("Jul 17, 2026"), "2026-07-17");
  assert.equal(parseDateLoose("jul 41"), null, "impossible day rejected");
  assert.equal(parseDateLoose("foo 17"), null, "not a month name");
  assert.equal(parseDateLoose("ju 17"), null, "under 3 letters is no month");
});

test("parseDateLoose: engine year-guesses from yearless input are rejected (SUB-228)", () => {
  // V8 reads a trailing number as a 2-digit year ("jul 17 99" → 1999) — a
  // pre-2000 guess without a written 4-digit year is null, never committed
  assert.equal(parseDateLoose("jul 17 99"), null);
  assert.equal(parseDateLoose("2/3"), null);
  assert.equal(parseDateLoose("May 5, 2026"), "2026-05-05", "written years still pass");
});

test("parseDateLoose: dotted dates are day-first", () => {
  assert.equal(parseDateLoose("7.8.2026"), "2026-08-07");
  assert.equal(parseDateLoose("17.8.2026"), "2026-08-17");
  assert.equal(parseDateLoose("01.12.2026"), "2026-12-01");
  assert.equal(parseDateLoose("29.2.2024"), "2024-02-29", "leap day accepted");
  assert.equal(parseDateLoose("29.2.2026"), null, "non-leap Feb 29 rejected");
  assert.equal(parseDateLoose("32.1.2026"), null);
  assert.equal(parseDateLoose("1.13.2026"), null);
});

test("parseDateLoose: invalid ISO-shaped input is rejected, not rolled over", () => {
  assert.equal(parseDateLoose("2026-02-30"), null);
  assert.equal(parseDateLoose("2026-13-01"), null);
  assert.equal(parseDateLoose("2026-04-31"), null);
  assert.equal(parseDateLoose("2026-02-30T12:00:00Z"), null, "datetime on a bad date too");
});

test("parseDateLoose: ISO datetimes keep their written date regardless of timezone", () => {
  assert.equal(parseDateLoose("2026-07-17T22:00:00Z"), "2026-07-17");
  assert.equal(parseDateLoose("2026-07-17T00:30:00+02:00"), "2026-07-17");
  assert.equal(parseDateLoose("2026-1-5"), "2026-01-05", "unpadded ISO-shaped");
});

test("monthGrid is a Monday-first 6-week grid", () => {
  const g = monthGrid(2026, 7); // July 2026 starts on a Wednesday
  assert.equal(g.length, 42);
  assert.equal(g[0].iso, "2026-06-29", "leads with the Monday before");
  assert.ok(!g[0].inMonth);
  const first = g.findIndex((c) => c.inMonth);
  assert.equal(g[first].iso, "2026-07-01");
  assert.equal(first, 2, "two lead cells before a Wednesday start");
  assert.equal(g.filter((c) => c.inMonth).length, 31);
  // January wraps the year on both ends
  const jan = monthGrid(2026, 1);
  assert.ok(jan.some((c) => c.iso.startsWith("2025-12")));
});

test("toIso pads; todayIso is ISO", () => {
  assert.equal(toIso(2026, 7, 5), "2026-07-05");
  assert.ok(isIsoDate(todayIso()));
});

test("msUntilNextMidnight lands just past local midnight", () => {
  // mid-day: the remaining hours plus 1ms
  const noon = new Date(2026, 6, 17, 12, 0, 0, 0);
  assert.equal(msUntilNextMidnight(noon), 12 * 3_600_000 + 1);
  // a second before midnight: 1001ms, not a full day
  const late = new Date(2026, 6, 17, 23, 59, 59, 0);
  assert.equal(msUntilNextMidnight(late), 1001);
  // exactly midnight: the next rollover is a full day away, landing on the
  // following date
  const onTheDot = new Date(2026, 6, 18, 0, 0, 0, 0);
  const fired = new Date(onTheDot.getTime() + msUntilNextMidnight(onTheDot));
  assert.equal(fired.getDate(), 19);
  // month boundary: July 31's next midnight is Aug 1
  const monthEnd = new Date(2026, 6, 31, 10, 0, 0, 0);
  const over = new Date(monthEnd.getTime() + msUntilNextMidnight(monthEnd));
  assert.equal(over.getMonth(), 7); // August (0-based)
  assert.equal(over.getDate(), 1);
});

test("shiftDate walks days across month and year bounds", () => {
  assert.equal(shiftDate("2026-07-17", -1), "2026-07-16");
  assert.equal(shiftDate("2026-07-17", 1), "2026-07-18");
  assert.equal(shiftDate("2026-07-01", -1), "2026-06-30");
  assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
});

test("daysAgoIso counts back on the local calendar, not UTC (SUB-718)", () => {
  // a UTC slice (toISOString) is a day off near local midnight; pin the
  // process to non-UTC zones on both offset directions and inject the clock
  const prevTz = process.env.TZ;
  try {
    // negative offset (UTC-4 in July): the UTC day flips 4h before local
    process.env.TZ = "America/New_York";
    const nyBefore = new Date("2026-07-18T03:30:00Z"); // Jul 17, 23:30 local
    assert.equal(daysAgoIso(0, nyBefore), "2026-07-17");
    const nyAfter = new Date("2026-07-18T04:30:00Z"); // Jul 18, 00:30 local
    assert.equal(daysAgoIso(0, nyAfter), "2026-07-18");
    assert.equal(daysAgoIso(30, nyAfter), "2026-06-18", "trim default crosses the month");
    assert.equal(daysAgoIso(30, nyBefore), "2026-06-17");

    // positive offset (UTC+9): the local day flips 9h before UTC
    process.env.TZ = "Asia/Tokyo";
    const jpAfter = new Date("2026-07-17T15:30:00Z"); // Jul 18, 00:30 local
    assert.equal(daysAgoIso(0, jpAfter), "2026-07-18");
    const jpBefore = new Date("2026-07-17T14:30:00Z"); // Jul 17, 23:30 local
    assert.equal(daysAgoIso(0, jpBefore), "2026-07-17");
    assert.equal(daysAgoIso(1, jpAfter), "2026-07-17", "yesterday is the previous local day");
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }

  // no injected clock: same basis as todayIso()/shiftDate, whatever the TZ
  assert.equal(daysAgoIso(0), todayIso());
  assert.equal(daysAgoIso(30), shiftDate(todayIso(), -30));
});

test("daysBetween counts whole calendar days, signed, DST-immune", () => {
  assert.equal(daysBetween("2026-07-10", "2026-07-17"), 7);
  assert.equal(daysBetween("2026-07-17", "2026-07-10"), -7);
  assert.equal(daysBetween("2026-07-17", "2026-07-17"), 0);
  assert.equal(daysBetween("2025-12-31", "2026-01-01"), 1, "crosses the year");
  assert.equal(daysBetween("2024-02-01", "2024-03-01"), 29, "leap February");
  assert.equal(daysBetween("2025-02-01", "2025-03-01"), 28, "plain February");
  // Europe/Berlin springs forward 2026-03-29: component arithmetic can't drift
  assert.equal(daysBetween("2026-03-01", "2026-04-01"), 31, "spans a DST transition");
});

test("durationFrom resolves d and w from a base date, rejects the rest", () => {
  assert.equal(durationFrom("7d", "2026-07-17"), "2026-07-24");
  assert.equal(durationFrom("2w", "2026-07-17"), "2026-07-31");
  assert.equal(durationFrom("0d", "2026-07-17"), "2026-07-17");
  assert.equal(durationFrom("1d", "2026-12-31"), "2027-01-01", "crosses the year");
  assert.equal(durationFrom("2026-07-17", "2026-07-17"), null, "an ISO date is no duration");
  assert.equal(durationFrom("7", "2026-07-17"), null, "a unit is required");
  assert.equal(durationFrom("7m", "2026-07-17"), null, "only d and w");
  assert.equal(durationFrom("soon", "2026-07-17"), null);
});

test("parseDateTimeLoose: a trailing HH:MM splits off, the day parses loosely (SUB-270)", () => {
  assert.deepEqual(parseDateTimeLoose("2026-07-19 14:30"), { day: "2026-07-19", time: "14:30" });
  assert.deepEqual(parseDateTimeLoose("2026-07-19T14:30"), { day: "2026-07-19", time: "14:30" });
  // SUB-714: a single-digit hour is accepted and padded on output
  assert.deepEqual(parseDateTimeLoose("2026-07-19 9:30"), { day: "2026-07-19", time: "09:30" });
  assert.deepEqual(parseDateTimeLoose("2026-07-19T9:30"), { day: "2026-07-19", time: "09:30" });
  assert.deepEqual(parseDateTimeLoose("jul 17 09:05"), {
    day: `${new Date().getFullYear()}-07-17`,
    time: "09:05",
  });
  assert.deepEqual(parseDateTimeLoose("17.8.2026 08:00"), { day: "2026-08-17", time: "08:00" });
});

test("parseDateTimeLoose: day-only input, garbage, and bad times", () => {
  assert.deepEqual(parseDateTimeLoose("2026-07-19"), { day: "2026-07-19", time: null });
  assert.deepEqual(parseDateTimeLoose("  2026-07-19  "), { day: "2026-07-19", time: null });
  assert.equal(parseDateTimeLoose("total junk :::"), null);
  assert.equal(parseDateTimeLoose(""), null);
  assert.equal(parseDateTimeLoose("2026-07-19 25:00"), null, "hour past 23");
  assert.equal(parseDateTimeLoose("2026-07-19 14:60"), null, "minute past 59");
  assert.equal(parseDateTimeLoose("2026-07-19 9:60"), null, "unpadded hour, minute past 59");
  assert.equal(parseDateTimeLoose("junk 14:30"), null, "time on an unparseable day");
  // seconds/Z datetimes fall back to parseDateLoose's day-only tolerance —
  // and so does a one-digit minute, which stays outside the time grammar
  assert.deepEqual(parseDateTimeLoose("2026-07-17T22:00:00Z"), { day: "2026-07-17", time: null });
  assert.deepEqual(parseDateTimeLoose("2026-07-19 9:5"), { day: "2026-07-19", time: null });
});
