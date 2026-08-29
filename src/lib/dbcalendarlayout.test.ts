import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calendarDateProp,
  calendarSeedDay,
  dbDateProps,
  dbLayoutEntries,
} from "./dbcalendarlayout.ts";
import { entriesByDay, monthWindow } from "./calendarfence.ts";
import { calendarEntries, isoDay, monthGridDays } from "./calendar.ts";
import { canonicalViewPref } from "./dbcolumns.ts";
import type { NoteMeta, PropSchema, SchemaConfig } from "./types.ts";

function note(path: string, props: Record<string, unknown>, folder = ""): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return {
    path,
    stem,
    title: (props.title as string) ?? stem,
    folder,
    props,
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const releaseSchema: Record<string, PropSchema> = {
  released: { kind: "date", options: [] },
  mastered: { kind: "date", options: [] },
  status: { options: [] },
};
const schema: SchemaConfig = { release: releaseSchema };

// the grid a July 2026 calendar renders — Mon 29 Jun … Sun 2 Aug
const july = monthWindow(2026, 6);

// ---------- which props a calendar can bind to ----------

test("offers the schema's date props in declared order", () => {
  const rows = [note("a.md", { type: "release", released: "2026-07-03" })];
  assert.deepEqual(dbDateProps(rows, releaseSchema, schema), ["released", "mastered"]);
});

test("offers a date prop the rows carry but the schema never declared", () => {
  const rows = [
    note("a.md", { type: "release", released: "2026-07-03" }),
    note("b.md", { type: "release", reissued: "2026-07-10" }),
  ];
  assert.deepEqual(dbDateProps(rows, releaseSchema, schema), [
    "released",
    "mastered",
    "reissued",
  ]);
});

test("never offers a date-shaped prop that is not scheduling", () => {
  // `created` is on every note and `repeat_until` drives recurrence — both are
  // date-shaped, neither is a day a row lands on
  const rows = [
    note("a.md", {
      type: "release",
      released: "2026-07-03",
      created: "2026-01-01",
      repeat: "weekly",
      repeat_until: "2026-08-01",
    }),
  ];
  const props = dbDateProps(rows, releaseSchema, schema);
  assert.ok(!props.includes("created"), `created is not a binding: ${props.join(", ")}`);
  assert.ok(!props.includes("repeat_until"), `repeat_until is not a binding: ${props.join(", ")}`);
});

test("a schema that DECLARES created or repeat_until as a date is refused too", () => {
  // the refusal cannot live on the observed half alone: a schema-declared
  // `created` would otherwise lead the offer list, become the default binding,
  // and draw an empty month — calendarEntries places nothing on those props
  const declared: Record<string, PropSchema> = {
    created: { kind: "date", options: [] },
    repeat_until: { kind: "date", options: [] },
    released: { kind: "date", options: [] },
  };
  const rows = [note("a.md", { type: "release", created: "2026-01-01", released: "2026-07-03" })];
  const props = dbDateProps(rows, declared, { release: declared });
  assert.deepEqual(props, ["released"]);
  // and so the default binding is one that actually places the row
  const bound = calendarDateProp(undefined, props);
  assert.equal(bound, "released");
  assert.equal(dbLayoutEntries(rows, { release: declared }, bound, july).length, 1);
});

test("a database with no date property offers no binding", () => {
  const bare: SchemaConfig = { gear: { status: { options: [] } } };
  const rows = [note("a.md", { type: "gear", status: "owned" })];
  assert.deepEqual(dbDateProps(rows, bare.gear, bare), []);
});

// ---------- resolving the pref's binding ----------

test("the pref's binding wins, in the authored spelling", () => {
  assert.equal(calendarDateProp("mastered", ["released", "mastered"]), "mastered");
});

test("a pref spelled differently from the prop still binds", () => {
  assert.equal(calendarDateProp("MASTERED", ["released", "mastered"]), "mastered");
});

test("a pref naming a prop that is gone falls back to the first offered", () => {
  assert.equal(calendarDateProp("shipped", ["released", "mastered"]), "released");
});

test("no pref takes the first offered; nothing offered binds nothing", () => {
  assert.equal(calendarDateProp(undefined, ["released"]), "released");
  assert.equal(calendarDateProp(undefined, []), null);
  assert.equal(calendarDateProp("released", []), null);
});

// ---------- placing rows on days ----------

test("rows land on their date prop's day, and only that prop's", () => {
  const rows = [
    note("a.md", { type: "release", released: "2026-07-03", mastered: "2026-07-01" }),
    note("b.md", { type: "release", released: "2026-07-03" }),
    note("c.md", { type: "release", released: "2026-07-20" }),
  ];
  const byDay = entriesByDay(dbLayoutEntries(rows, schema, "released", july));
  assert.deepEqual(
    byDay.get("2026-07-03")?.map((e) => e.path),
    ["a.md", "b.md"],
    "same day, sorted by title"
  );
  assert.deepEqual(byDay.get("2026-07-20")?.map((e) => e.path), ["c.md"]);
  assert.equal(byDay.get("2026-07-01"), undefined, "the other date prop is not on this grid");
});

test("binding the other date prop re-places the same rows", () => {
  const rows = [note("a.md", { type: "release", released: "2026-07-03", mastered: "2026-07-01" })];
  const byDay = entriesByDay(dbLayoutEntries(rows, schema, "mastered", july));
  assert.deepEqual(byDay.get("2026-07-01")?.map((e) => e.path), ["a.md"]);
  assert.equal(byDay.get("2026-07-03"), undefined);
});

test("no binding draws an empty grid rather than guessing one", () => {
  const rows = [note("a.md", { type: "release", released: "2026-07-03" })];
  assert.deepEqual(dbLayoutEntries(rows, schema, null, july), []);
});

test("a day's entries sort by time of day, then title", () => {
  const rows = [
    note("late.md", { type: "release", released: "2026-07-03 21:00" }),
    note("early.md", { type: "release", released: "2026-07-03 09:00" }),
    note("allday.md", { type: "release", released: "2026-07-03" }),
  ];
  assert.deepEqual(
    dbLayoutEntries(rows, schema, "released", july).map((e) => e.path),
    ["allday.md", "early.md", "late.md"]
  );
});

// ---------- recurrence rides calendarEntries, never a second cadence ----------

test("a repeating row fills the month exactly as the Calendar pane expands it", () => {
  const rows = [note("standup.md", { type: "release", released: "2026-07-06", repeat: "weekly" })];
  const days = dbLayoutEntries(rows, schema, "released", july).map((e) => e.day);
  assert.deepEqual(days, [
    "2026-07-06",
    "2026-07-13",
    "2026-07-20",
    "2026-07-27",
    // the grid's window runs to Sun 2 Aug, so the next occurrence is on it
  ]);
  assert.ok(
    dbLayoutEntries(rows, schema, "released", july).every((e) => e.repeating),
    "every instance is marked repeating, anchor included"
  );
});

test("repeat_until stops the series, repeat_skip drops the day", () => {
  const rows = [
    note("standup.md", {
      type: "release",
      released: "2026-07-06",
      repeat: "weekly",
      repeat_until: "2026-07-20",
      repeat_skip: ["2026-07-13"],
    }),
  ];
  assert.deepEqual(
    dbLayoutEntries(rows, schema, "released", july).map((e) => e.day),
    ["2026-07-06", "2026-07-20"]
  );
});

test("the layout's entries ARE calendarEntries' — no second expansion", () => {
  // the standing rule, asserted: whatever the shared expander produces for
  // this prop and window is exactly what the grid draws, in sorted order
  const rows = [
    note("a.md", { type: "release", released: "2026-07-06", repeat: "every 2 days" }),
    note("b.md", { type: "release", released: "2026-07-09" }),
  ];
  const expected = calendarEntries(rows, schema, july)
    .filter((e) => e.prop === "released")
    .map((e) => `${e.day}:${e.path}`)
    .sort();
  const got = dbLayoutEntries(rows, schema, "released", july)
    .map((e) => `${e.day}:${e.path}`)
    .sort();
  assert.deepEqual(got, expected);
});

test("a row opting out of the calendar is not on the grid", () => {
  const rows = [
    note("a.md", { type: "release", released: "2026-07-03", calendar: false }),
    note("b.md", { type: "release", released: "2026-07-03" }),
  ];
  assert.deepEqual(
    dbLayoutEntries(rows, schema, "released", july).map((e) => e.path),
    ["b.md"]
  );
});

test("a multi-day range covers every day it spans", () => {
  const rows = [note("tour.md", { type: "release", released: "2026-07-03/2026-07-06" })];
  assert.deepEqual(
    dbLayoutEntries(rows, schema, "released", july).map((e) => e.day),
    ["2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"]
  );
});

test("a span reaching in from the previous month paints on every day drawn", () => {
  // 28 Jun → 2 Jul; the July grid opens on Mon 29 Jun. calendarEntries always
  // emits a span's start day (overdue scans depend on it), so the entry list
  // carries 28 Jun — the grid never looks that day up, and what a reader sees
  // is the run from the first drawn day to the range's end.
  const rows = [note("tour.md", { type: "release", released: "2026-06-28/2026-07-02" })];
  const byDay = entriesByDay(dbLayoutEntries(rows, schema, "released", july));
  const drawn = monthGridDays(2026, 6).map(isoDay).filter((iso) => byDay.has(iso));
  assert.deepEqual(drawn, ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"]);
  // and the continuation days say so, so they do not read as new entries
  assert.deepEqual(
    drawn.map((iso) => byDay.get(iso)?.[0].spanPos),
    ["mid", "mid", "mid", "end"]
  );
});

test("a span running past the month keeps its interior inside the window", () => {
  // 30 Jul → 30 Sep, against a grid that ends on Sun 2 Aug: every day past the
  // window is dropped, so paging never expands a run nobody can see — a
  // two-month range costs this grid four chips, not sixty-three
  const rows = [note("tour.md", { type: "release", released: "2026-07-30/2026-09-30" })];
  const days = dbLayoutEntries(rows, schema, "released", july).map((e) => e.day);
  assert.deepEqual(days, ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  // and the run reads as continuing off the grid, not as ending on the 2nd
  assert.deepEqual(
    dbLayoutEntries(rows, schema, "released", july).map((e) => e.spanPos),
    ["start", "mid", "mid", "mid"]
  );
});

test("a four-week month draws four weeks, and every row still lands", () => {
  // February 2027 starts on a Monday and ends on a Sunday — the shortest grid
  // the month view ever draws, and the one a fixed six-row grid would pad
  const feb = monthWindow(2027, 1);
  assert.equal(monthGridDays(2027, 1).length, 28);
  assert.equal(feb.start, "2027-02-01");
  assert.equal(feb.end, "2027-02-28");
  const rows = [
    note("a.md", { type: "release", released: "2027-02-01" }),
    note("b.md", { type: "release", released: "2027-02-28" }),
  ];
  const byDay = entriesByDay(dbLayoutEntries(rows, schema, "released", feb));
  assert.deepEqual(byDay.get("2027-02-01")?.map((e) => e.path), ["a.md"]);
  assert.deepEqual(byDay.get("2027-02-28")?.map((e) => e.path), ["b.md"]);
});

test("a six-week month draws six weeks, including the days either side", () => {
  // August 2026 starts on a Saturday and needs six rows; the grid reaches back
  // to Mon 27 Jul and forward to Sun 6 Sep, and rows on those days are drawn
  const aug = monthWindow(2026, 7);
  const grid = monthGridDays(2026, 7).map(isoDay);
  assert.equal(grid.length, 42);
  assert.equal(aug.start, "2026-07-27");
  assert.equal(aug.end, "2026-09-06");
  const rows = [
    note("early.md", { type: "release", released: "2026-07-27" }),
    note("late.md", { type: "release", released: "2026-09-06" }),
    note("out.md", { type: "release", released: "2026-09-07" }),
  ];
  const byDay = entriesByDay(dbLayoutEntries(rows, schema, "released", aug));
  assert.deepEqual(
    grid.filter((iso) => byDay.has(iso)),
    ["2026-07-27", "2026-09-06"]
  );
  // the day after the grid ends is not a cell, so its row is simply not here
  assert.equal(grid.includes("2026-09-07"), false);
});

test("cal_date survives a layout switch away and back", () => {
  // the switcher writes a layout over the database's whole pref; the calendar's
  // binding is not a table key, so nothing on the way through may drop it
  const columns = ["released", "mastered", "status"];
  const bound = canonicalViewPref({ view: "calendar", cal_date: "mastered" }, columns);
  const toTable = canonicalViewPref({ ...bound, view: "table" }, columns);
  assert.equal(toTable.cal_date, "mastered");
  const back = canonicalViewPref({ ...toTable, view: "calendar" }, columns);
  assert.equal(back.cal_date, "mastered");
  assert.equal(calendarDateProp(back.cal_date, ["released", "mastered"]), "mastered");
});

test("a row born on the calendar takes the day the reader is looking at", () => {
  // the month today falls in: today, so the new row lands where the eye is
  assert.equal(calendarSeedDay(2026, 7, "2026-08-29"), "2026-08-29");
  // a month the reader paged to: its first day, so the row is still on screen
  assert.equal(calendarSeedDay(2026, 8, "2026-08-29"), "2026-09-01");
  assert.equal(calendarSeedDay(2026, 6, "2026-08-29"), "2026-07-01");
  // same month number, different year — a year apart is not "this month"
  assert.equal(calendarSeedDay(2027, 7, "2026-08-29"), "2027-08-01");
  // day precision, and a value the grid parses back onto that very day
  const day = calendarSeedDay(2026, 8, "2026-08-29");
  const placed = calendarEntries(
    [note("New.md", { type: "release", released: day })],
    { release: { released: { kind: "date" } } } as unknown as SchemaConfig,
    monthWindow(2026, 8)
  );
  assert.deepEqual(placed.map((e) => e.day), ["2026-09-01"]);
  assert.equal(placed[0].time, undefined, "all-day, like a date with no time");
});
