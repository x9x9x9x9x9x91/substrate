import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import {
  addDays,
  addMonths,
  calendarEntries,
  calendarEntriesForWindows,
  calendarTypes,
  cellDayLabel,
  clampedRangeEnd,
  datePropFor,
  dateRangeValue,
  dayColumn,
  entriesForNote,
  folderFor,
  humanDay,
  isDeadline,
  isoDay,
  monthGridDays,
  overdueEntries,
  parseDay,
  parseRepeat,
  shiftedRangeEnd,
  splitDateRange,
  splitDayTime,
  startOfWeek,
  statusSchemaFor,
  weekDays,
} from "./calendar.ts";

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

test("isoDay / parseDay round-trip local days", () => {
  const d = new Date(2026, 6, 17); // Jul 17 2026 local
  assert.equal(isoDay(d), "2026-07-17");
  assert.equal(isoDay(new Date(2026, 0, 5)), "2026-01-05");
  const p = parseDay("2026-07-17");
  assert.ok(p);
  assert.equal(p.getFullYear(), 2026);
  assert.equal(p.getMonth(), 6);
  assert.equal(p.getDate(), 17);
});

test("parseDay rejects malformed and impossible dates", () => {
  assert.equal(parseDay("2026-7-17"), null);
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("2026-13-01"), null);
  assert.equal(parseDay("17.07.2026"), null);
  assert.equal(parseDay("2026-07-17T10:00"), null);
  assert.equal(parseDay(""), null);
});

test("parseDay keeps two-digit years in their own century (SUB-1177)", () => {
  // the multi-arg Date constructor reads years 0–99 as 19xx; the round-trip
  // check never looked at the year, so these came back off by 1900
  const y99 = parseDay("0099-01-01");
  assert.ok(y99);
  assert.equal(y99.getFullYear(), 99);
  assert.equal(y99.getMonth(), 0);
  assert.equal(y99.getDate(), 1);
  // (isoDay renders that year unpadded — "99-01-01"; a separate gap, and out
  // of scope here: this branch touches parseDay only.)
  const y0 = parseDay("0000-01-01");
  assert.ok(y0);
  assert.equal(y0.getFullYear(), 0);
  const y26 = parseDay("0026-03-04");
  assert.ok(y26);
  assert.equal(y26.getFullYear(), 26);
  assert.equal(y26.getMonth(), 2);
  assert.equal(y26.getDate(), 4);
  // impossible days stay rejected in the low-year range too
  assert.equal(parseDay("0099-02-30"), null);
  assert.equal(parseDay("0099-13-01"), null);
  // ordinary years are untouched, leap day included
  assert.equal(isoDay(parseDay("2024-02-29")!), "2024-02-29");
  assert.equal(parseDay("2026-02-29"), null);
  assert.equal(isoDay(parseDay("1899-12-31")!), "1899-12-31");
  assert.equal(isoDay(parseDay("1900-01-01")!), "1900-01-01");
});

test("weeks start Monday; month grid covers only the month's weeks", () => {
  // 2026-07-17 is a Friday
  assert.equal(isoDay(startOfWeek(new Date(2026, 6, 17))), "2026-07-13");
  assert.equal(isoDay(startOfWeek(new Date(2026, 6, 13))), "2026-07-13"); // Monday stays
  assert.equal(isoDay(startOfWeek(new Date(2026, 6, 19))), "2026-07-13"); // Sunday back
  const grid = monthGridDays(2026, 6);
  assert.equal(grid.length, 35); // July 2026 spans 5 Monday-start weeks
  assert.equal(isoDay(grid[0]), "2026-06-29"); // Monday before Jul 1 (a Wednesday)
  assert.equal(isoDay(grid[34]), "2026-08-02");
  const week = weekDays(new Date(2026, 6, 17));
  assert.deepEqual(week.map(isoDay), [
    "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16",
    "2026-07-17", "2026-07-18", "2026-07-19",
  ]);
});

test("Day is the week canvas's column set with one day in it (SUB-1170)", () => {
  const col = dayColumn(new Date(2026, 6, 17, 14, 30));
  assert.equal(col.length, 1);
  assert.equal(isoDay(col[0]), "2026-07-17");
  // normalized to midnight like weekDays/monthGridDays, so the canvas's
  // per-column time maths start from the same place in either layout
  assert.equal(col[0].getHours(), 0);
  assert.equal(col[0].getMinutes(), 0);
  // and it steps across a month boundary without any month logic
  assert.equal(isoDay(dayColumn(addDays(new Date(2026, 6, 31), 1))[0]), "2026-08-01");
});

test("month grid sizes to 4–6 weeks as the month lands (SUB-248)", () => {
  // August 2026 starts on a Saturday — needs all 6 weeks
  const aug = monthGridDays(2026, 7);
  assert.equal(aug.length, 42);
  assert.equal(isoDay(aug[0]), "2026-07-27");
  assert.equal(isoDay(aug[41]), "2026-09-06");
  // February 2027 starts on a Monday with 28 days — exactly 4 weeks
  const feb = monthGridDays(2027, 1);
  assert.equal(feb.length, 28);
  assert.equal(isoDay(feb[0]), "2027-02-01");
  assert.equal(isoDay(feb[27]), "2027-02-28");
});

test("addMonths clamps to the target month's length", () => {
  assert.equal(isoDay(addMonths(new Date(2026, 0, 31), 1)), "2026-02-28");
  assert.equal(isoDay(addMonths(new Date(2026, 6, 17), -1)), "2026-06-17");
  assert.equal(isoDay(addDays(new Date(2026, 11, 31), 1)), "2027-01-01");
});

test("heuristic discovery: ISO-date props appear, reserved props never", () => {
  const notes = [
    note("Tasks/Ship SMP-031.md", { type: "task", due: "2026-07-20", created: "2026-07-01" }, "Tasks"),
    note("Slow Bloom EP.md", { type: "release", release_date: "2026-08-01", created: "2026-07-01" }),
    note("Welcome.md", { created: "2026-07-17" }),
  ];
  const entries = calendarEntries(notes, {});
  assert.deepEqual(
    entries.map((e) => [e.path, e.prop, e.day]),
    [
      ["Tasks/Ship SMP-031.md", "due", "2026-07-20"],
      ["Slow Bloom EP.md", "release_date", "2026-08-01"],
    ]
  );
});

test("schema kind wins over the heuristic in both directions", () => {
  const schema: SchemaConfig = {
    task: {
      due: { options: [], kind: "date" },
      review: { options: [], kind: "file" }, // ISO value, but declared file
    },
  };
  const notes = [
    note("Tasks/T.md", { type: "task", due: "not-a-date", review: "2026-07-22", extra: "2026-07-23" }, "Tasks"),
  ];
  const entries = calendarEntries(notes, schema);
  // due is declared date but unparsable → dropped; review excluded by kind;
  // extra still heuristic
  assert.deepEqual(entries.map((e) => [e.prop, e.day]), [["extra", "2026-07-23"]]);
  assert.deepEqual(
    calendarEntries([note("Tasks/T.md", { type: "task", due: "2026-07-22" }, "Tasks")], schema).map((e) => e.prop),
    ["due"]
  );
});

test("calendar folds Type, Status, and reserved property names", () => {
  const schema: SchemaConfig = {
    Release: {
      Due: { options: [], kind: "date" },
      Status: { options: [{ value: "done" }] },
    },
  };
  const release = note("Release.md", {
    Type: "RELEASE",
    Due: "2026-08-14",
    Status: "done",
    Created: "2026-08-01",
    Repeat_Until: "2026-08-30",
  });

  const entries = calendarEntries([release], schema);
  assert.deepEqual(entries.map((entry) => [entry.prop, entry.type, entry.status]), [
    ["Due", "RELEASE", "done"],
  ]);
  assert.equal(datePropFor("release", [release], schema), "Due");
  assert.equal(statusSchemaFor(schema, "RELEASE")?.options[0]?.value, "done");
});

test("non-string and near-miss values are not dates", () => {
  const notes = [
    note("N.md", {
      type: "log",
      day: "2026-7-4", // not zero-padded
      when: "17.07.2026",
      count: 20260717,
      range: ["2026-07-17"],
      ok: "2026-07-18",
    }),
  ];
  const entries = calendarEntries(notes, {});
  assert.deepEqual(entries.map((e) => e.prop), ["ok"]);
});

test("a note with several date props lands on several days", () => {
  const notes = [note("R.md", { type: "release", release_date: "2026-08-01", master_due: "2026-07-25" })];
  const entries = calendarEntries(notes, {});
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map((e) => e.day)), new Set(["2026-08-01", "2026-07-25"]));
});

test("datePropFor: schema first, usage histogram second, date as fallback", () => {
  const notes = [
    note("a.md", { type: "task", due: "2026-07-20" }),
    note("b.md", { type: "task", due: "2026-07-21", starts: "2026-07-19" }),
  ];
  assert.equal(datePropFor("task", notes, {}), "due");
  assert.equal(datePropFor("task", notes, { task: { planned: { options: [], kind: "date" } } }), "planned");
  assert.equal(datePropFor("event", [], {}), "date");
  assert.equal(datePropFor("release", [], {}), "date");
});

test("app-machinery types (dashboard, sheet) need a schema declaration", () => {
  const notes = [
    note("Dashboards/Yield APR.md", { type: "dashboard", fx_date: "2026-07-16" }, "Dashboards"),
    note("Holdings.md", { type: "sheet", fx_date: "2026-07-16" }),
  ];
  assert.deepEqual(calendarEntries(notes, {}), []);
  // …but an explicit schema kind still lands them on the grid
  const schema: SchemaConfig = { sheet: { review: { options: [], kind: "date" } } };
  const withSchema = calendarEntries(
    [note("Holdings.md", { type: "sheet", review: "2026-07-30", fx_date: "2026-07-16" })],
    schema
  );
  assert.deepEqual(withSchema.map((e) => e.prop), ["review"]);
  // Type values are hand-authored: casing must not re-enable heuristics for
  // a functional type when the note has a real, nonempty date-shaped prop.
  assert.deepEqual(
    calendarEntries([note("Dashboards/Mixed.md", { type: "Dashboard", fx_date: "2026-07-16" })], {}),
    []
  );
});

test("calendarTypes: event first, then schema databases with a date prop (SUB-175)", () => {
  // schema-driven, not entry-driven: which types appear is a schema fact,
  // not an accident of which notes currently carry dates
  const schema: SchemaConfig = {
    task: { due: { options: [], kind: "date" }, status: { options: [] } },
    release: { released: { options: [], kind: "date" } },
    gear: { manual: { options: [], kind: "file" } },
    contact: {},
  };
  assert.deepEqual(calendarTypes(schema), ["event", "release", "task"]);
  // no date-kind props anywhere → only standalone events
  assert.deepEqual(calendarTypes({ task: { status: { options: [] } } }), ["event"]);
  assert.deepEqual(calendarTypes({}), ["event"]);
});

test("calendarTypes: functional types stay out even with a declared date prop", () => {
  const schema: SchemaConfig = {
    Sheet: { review: { options: [], kind: "date" } },
    dashboard: { since: { options: [], kind: "date" } },
    task: { due: { options: [], kind: "date" } },
  };
  assert.deepEqual(calendarTypes(schema), ["event", "task"]);
});

test("calendarTypes: reserved type-map keys (icon, home) are not prop specs", () => {
  // schema.json merges `icon` (a DbIcon object) and `home` (a string) into the
  // type map — neither has a `.kind`, neither may crash or qualify the type
  const schema = {
    gear: { icon: { glyph: "music", tint: "violet" }, home: "Stuff" },
    release: { icon: { emoji: "🎵" }, released: { options: [], kind: "date" } },
  } as unknown as SchemaConfig;
  assert.deepEqual(calendarTypes(schema), ["event", "release"]);
});

test("calendar: false opts a note out of the calendar (SUB-175)", () => {
  const dated = { type: "task", due: "2026-07-20" };
  assert.deepEqual(calendarEntries([note("a.md", { ...dated, calendar: false })], {}), []);
  // imports / hand edits may carry the string form
  assert.deepEqual(calendarEntries([note("b.md", { ...dated, calendar: "false" })], {}), []);
  // true, other values, or absent leave the note on the grid
  for (const v of [true, "true", "yes"] as unknown[]) {
    const entries = calendarEntries([note("c.md", { ...dated, calendar: v })], {});
    assert.deepEqual(entries.map((e) => e.day), ["2026-07-20"]);
  }
  assert.equal(calendarEntries([note("d.md", dated)], {}).length, 1);
  // the flag itself is never read as a date, however date-shaped its value
  assert.deepEqual(calendarEntries([note("e.md", { calendar: "2026-07-20" })], {}), []);
});

test("folderFor: events into Calendar, databases into their home folder", () => {
  const notes = [
    note("Tasks/a.md", { type: "task", due: "2026-07-20" }, "Tasks"),
    note("Tasks/b.md", { type: "task" }, "Tasks"),
    note("x.md", { type: "task" }),
  ];
  assert.equal(folderFor("event", notes), "Calendar");
  assert.equal(folderFor("task", notes), "Tasks");
  assert.equal(folderFor("TASK", notes), "Tasks");
  assert.equal(folderFor("brand-new", []), "");
});

test("folderFor: an explicit home wins; events keep Calendar (SUB-85)", () => {
  const notes = [note("Tasks/a.md", { type: "task", due: "2026-07-20" }, "Tasks")];
  assert.equal(folderFor("task", notes, "Life/Admin"), "Life/Admin");
  assert.equal(folderFor("task", [], "Life/Admin"), "Life/Admin", "no notes needed");
  // events never take a home; blank falls back to the heuristic
  assert.equal(folderFor("event", notes, "Life/Admin"), "Calendar");
  assert.equal(folderFor("EVENT", notes, "Life/Admin"), "Calendar");
  assert.equal(folderFor("task", notes, " "), "Tasks");
});

test("humanDay: this year drops the year", () => {
  const now = new Date(2026, 6, 17);
  assert.equal(humanDay("2026-07-17", now), "Jul 17");
  assert.equal(humanDay("2027-01-03", now), "Jan 3, 2027");
  assert.equal(humanDay("garbage", now), "garbage");
});

test("cellDayLabel: the 1st names its month, every other day stays bare (SUB-701)", () => {
  assert.equal(cellDayLabel(new Date(2026, 7, 1)), "Aug 1");
  assert.equal(cellDayLabel(new Date(2026, 7, 2)), "2");
  assert.equal(cellDayLabel(new Date(2026, 11, 31)), "31");
  assert.equal(cellDayLabel(new Date(2027, 0, 1)), "Jan 1");
});

/* ----- recurrence ----- */

test("parseRepeat: bare cadences, case- and space-insensitive", () => {
  assert.deepEqual(parseRepeat("daily"), { unit: "day", n: 1 });
  assert.deepEqual(parseRepeat("Weekly"), { unit: "week", n: 1 });
  assert.deepEqual(parseRepeat("  MONTHLY "), { unit: "month", n: 1 });
  assert.deepEqual(parseRepeat("yearly"), { unit: "year", n: 1 });
});

test("parseRepeat: every N units, singular and plural", () => {
  assert.deepEqual(parseRepeat("every 2 weeks"), { unit: "week", n: 2 });
  assert.deepEqual(parseRepeat("every 1 day"), { unit: "day", n: 1 });
  assert.deepEqual(parseRepeat("every 3 months"), { unit: "month", n: 3 });
  assert.deepEqual(parseRepeat("Every 10 Years"), { unit: "year", n: 10 });
});

test("parseRepeat: anything else is non-repeating", () => {
  const garbage: unknown[] = [
    "",
    "every day",
    "every 0 days",
    "every -2 weeks",
    "every 2.5 weeks",
    "every  2  weeks",
    "fortnightly",
    "weekly,",
    null,
    undefined,
    7,
    ["weekly"],
    { unit: "week" },
  ];
  for (const v of garbage) assert.equal(parseRepeat(v), null, JSON.stringify(v));
});

test("recurrence: daily expands inside the window, repeating flag on every instance", () => {
  const notes = [note("Calendar/Gym.md", { type: "event", date: "2026-07-18", repeat: "daily" }, "Calendar")];
  const entries = calendarEntries(notes, {}, { start: "2026-07-18", end: "2026-07-22" });
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22"]
  );
  assert.ok(entries.every((e) => e.repeating === true), "anchor included");
});

test("recurrence: weekly crosses window edges correctly", () => {
  const notes = [note("E.md", { date: "2026-07-10", repeat: "weekly" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-16", end: "2026-07-25" });
  // the anchor (07-10) and 07-31 fall outside; 07-17 and 07-24 survive
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-17", "2026-07-24"]);
});

test("recurrence: every N units steps by N", () => {
  const notes = [note("E.md", { date: "2026-07-18", repeat: "every 3 days" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-18", end: "2026-07-28" });
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-18", "2026-07-21", "2026-07-24", "2026-07-27"]);
});

test("recurrence: monthly clamps Jan 31 → Feb 28, then steps from the anchor again", () => {
  const notes = [note("E.md", { date: "2026-01-31", repeat: "monthly" })];
  const entries = calendarEntries(notes, {}, { start: "2026-01-01", end: "2026-04-30" });
  assert.deepEqual(entries.map((e) => e.day), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("recurrence: yearly steps by twelve months", () => {
  const notes = [note("E.md", { date: "2026-07-18", repeat: "yearly" })];
  const entries = calendarEntries(notes, {}, { start: "2026-01-01", end: "2029-12-31" });
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-18", "2027-07-18", "2028-07-18", "2029-07-18"]);
});

test("recurrence: repeat_until is inclusive", () => {
  const notes = [note("E.md", { date: "2026-07-18", repeat: "daily", repeat_until: "2026-07-20" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-18", end: "2026-07-31" });
  // the occurrence ON the until-day survives, the next one doesn't
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-18", "2026-07-19", "2026-07-20"]);
  // an until before the anchor (a typo, usually) truncates the series but
  // never hides the note itself — the anchor still renders
  const truncated = calendarEntries(
    [note("E.md", { date: "2026-07-18", repeat: "daily", repeat_until: "2026-07-17" })],
    {},
    { start: "2026-01-01", end: "2026-12-31" }
  );
  assert.deepEqual(truncated.map((e) => e.day), ["2026-07-18"]);
});

test("recurrence: repeat_skip removes a middle occurrence and the anchor itself", () => {
  const notes = [
    note("E.md", { date: "2026-07-18", repeat: "daily", repeat_skip: ["2026-07-18", "2026-07-20"] }),
  ];
  const entries = calendarEntries(notes, {}, { start: "2026-07-18", end: "2026-07-22" });
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-19", "2026-07-21", "2026-07-22"]);
});

test("recurrence: no window → only the surviving anchor", () => {
  const daily = { date: "2026-07-18", repeat: "daily" };
  assert.deepEqual(calendarEntries([note("E.md", daily)], {}).map((e) => e.day), ["2026-07-18"]);
  // …unless the anchor itself is skipped; an until before the anchor no
  // longer hides it
  assert.deepEqual(calendarEntries([note("E.md", { ...daily, repeat_skip: ["2026-07-18"] })], {}), []);
  assert.deepEqual(
    calendarEntries([note("E.md", { ...daily, repeat_until: "2026-07-17" })], {}).map((e) => e.day),
    ["2026-07-18"]
  );
});

test("recurrence: the 1000-occurrence cap guards a daily series with no until", () => {
  const notes = [note("E.md", { date: "2026-07-18", repeat: "daily" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-18", end: "2126-07-18" });
  assert.equal(entries.length, 1000);
  assert.equal(entries[0].day, "2026-07-18");
  assert.equal(entries[999].day, "2029-04-12");
});

test("recurrence: a series anchored years back still surfaces in a small window", () => {
  const notes = [note("E.md", { date: "2024-01-05", repeat: "weekly" })]; // a Friday
  const entries = calendarEntries(notes, {}, { start: "2026-07-13", end: "2026-07-19" });
  // 2026-07-17 is that week's Friday — the only occurrence inside
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-17"]);
});

/* Expansion seeks to the window arithmetically. Walking there from
   the anchor spent the 1000-occurrence budget on days nobody asked for, so a
   viewport far from the anchor came back empty. */
test("recurrence: a weekly series anchored 3 years back fills a viewport window", () => {
  const notes = [note("E.md", { date: "2023-07-19", repeat: "weekly" })]; // a Wednesday
  const entries = calendarEntries(notes, {}, { start: "2026-06-01", end: "2026-07-31" });
  assert.ok(entries.length > 0, "the window is not empty");
  assert.ok(entries.map((e) => e.day).includes("2026-07-15"), "a Wednesday inside");
  assert.equal(entries[0].day, "2026-06-03", "first occurrence at or after start");
  assert.equal(entries[entries.length - 1].day, "2026-07-29");
  assert.ok(entries.every((e) => e.repeating === true));
});

test("recurrence: a daily series anchored 3 years back still shows today's occurrence", () => {
  const notes = [note("E.md", { date: "2023-07-19", repeat: "daily" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-27", end: "2026-08-09" });
  assert.deepEqual(entries[0].day, "2026-07-27", "today, not a day 3 years of walking away");
  assert.equal(entries.length, 14);
});

test("recurrence: a series anchored far in the future fills a window around it", () => {
  const notes = [note("E.md", { date: "2026-07-19", repeat: "weekly" })]; // a Sunday
  const entries = calendarEntries(notes, {}, { start: "2029-04-01", end: "2029-04-30" });
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2029-04-01", "2029-04-08", "2029-04-15", "2029-04-22", "2029-04-29"]
  );
});

test("recurrence: monthly/yearly seeking respects month-end clamping", () => {
  // Jan 31 monthly: each step clamps from the ANCHOR, so short months land on
  // their last day and the seek must not skip past one
  const monthly = calendarEntries(
    [note("E.md", { date: "2024-01-31", repeat: "monthly" })],
    {},
    { start: "2026-02-01", end: "2026-04-30" }
  );
  assert.deepEqual(monthly.map((e) => e.day), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  // a leap-day yearly anchor clamps every non-leap year
  const yearly = calendarEntries(
    [note("E.md", { date: "2024-02-29", repeat: "yearly" })],
    {},
    { start: "2027-01-01", end: "2028-12-31" }
  );
  assert.deepEqual(yearly.map((e) => e.day), ["2027-02-28", "2028-02-29"]);
});

test("recurrence: seeking lands on the window's first day when it is an occurrence", () => {
  // an every-3-days cadence whose stride steps exactly onto window.start
  const entries = calendarEntries(
    [note("E.md", { date: "2020-01-03", repeat: "every 3 days" })], // 2397 days = 799 strides
    {},
    { start: "2026-07-27", end: "2026-08-02" }
  );
  assert.equal(entries[0].day, "2026-07-27", "an occurrence ON start is not skipped");
});

/* The actual failure: the pane covered grid + Upcoming with ONE window,
   so paging back stretched the span until MAX_OCCURRENCES truncated a daily
   series short of today — grid fine, Today and Upcoming empty. */
test("two windows: a far-back grid does not starve the upcoming window", () => {
  const notes = [note("E.md", { type: "event", date: "2020-01-01", repeat: "daily" })];
  const grid = { start: "2023-11-01", end: "2023-11-30" }; // paged ~32 months back
  const upcoming = { start: "2026-07-27", end: "2026-08-09" };
  // one stretched window: the cap lands long before the upcoming span
  const stretched = calendarEntries(notes, {}, { start: grid.start, end: upcoming.end });
  assert.equal(stretched.length, 1000, "the cap truncates");
  assert.ok(
    !stretched.some((e) => e.day === "2026-08-09"),
    "the tail of Upcoming never survives the stretch"
  );
  // two bounded windows: each surface gets its own budget
  const days = calendarEntriesForWindows(notes, {}, [grid, upcoming]).map((e) => e.day);
  assert.ok(days.includes("2023-11-01"), "grid start");
  assert.ok(days.includes("2023-11-30"), "grid end");
  assert.ok(days.includes("2026-07-27"), "today");
  assert.ok(days.includes("2026-08-09"), "the last upcoming day");
  assert.equal(days.length, 30 + 14);
});

test("two windows: overlapping windows emit each (note, prop, day) once", () => {
  const notes = [
    note("E.md", { type: "event", date: "2026-07-20", repeat: "daily" }),
    note("Plain.md", { type: "event", date: "2026-07-22" }), // non-repeating: window-agnostic
  ];
  const entries = calendarEntriesForWindows(notes, {}, [
    { start: "2026-07-20", end: "2026-07-25" },
    { start: "2026-07-23", end: "2026-07-28" },
  ]);
  const keys = entries.map((e) => `${e.path} ${e.prop} ${e.day}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicates across the overlap");
  const plain = entries.filter((e) => e.path === "Plain.md");
  assert.equal(plain.length, 1, "a non-repeating note surfaces once, not once per window");
});

test("recurrence: repeat applies to all of the note's date props identically", () => {
  const notes = [note("R.md", { release_date: "2026-08-01", master_due: "2026-07-25", repeat: "weekly" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-25", end: "2026-08-08" });
  const byProp = new Map<string, string[]>();
  for (const e of entries) byProp.set(e.prop, [...(byProp.get(e.prop) ?? []), e.day]);
  assert.deepEqual(byProp.get("master_due"), ["2026-07-25", "2026-08-01", "2026-08-08"]);
  assert.deepEqual(byProp.get("release_date"), ["2026-08-01", "2026-08-08"]);
});

test("recurrence: an unparsable repeat value leaves the note non-repeating", () => {
  const notes = [note("E.md", { date: "2026-07-18", repeat: "every blue moon" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-01", end: "2026-08-31" });
  assert.deepEqual(entries.map((e) => e.day), ["2026-07-18"]);
  assert.equal(entries[0].repeating, undefined);
});

test("repeat/repeat_until/repeat_skip never become calendar entries themselves", () => {
  const notes = [
    note("E.md", { date: "2026-07-18", repeat: "weekly", repeat_until: "2026-12-31", repeat_skip: ["2026-08-01"] }),
  ];
  assert.deepEqual(
    [...new Set(calendarEntries(notes, {}).map((e) => e.prop))],
    ["date"]
  );
  // even hand-written bare: a date-shaped repeat_until/repeat_skip on an
  // otherwise undated note yields nothing
  assert.deepEqual(
    calendarEntries([note("F.md", { repeat_until: "2026-12-31", repeat_skip: "2026-07-18" })], {}),
    []
  );
});

test("overdueEntries: past non-repeating deadlines only, oldest first (SUB-206)", () => {
  const schema: SchemaConfig = {
    task: { due: { options: [], kind: "date", notify: true } },
    release: { released: { options: [], kind: "date" } }, // no notify → not a deadline
  };
  const notes = [
    note("Tasks/B older.md", { type: "task", due: "2026-07-10" }, "Tasks"),
    note("Tasks/A newer.md", { type: "task", due: "2026-07-15" }, "Tasks"),
    note("Tasks/Today.md", { type: "task", due: "2026-07-19" }, "Tasks"), // due today → not overdue
    note("Tasks/Future.md", { type: "task", due: "2026-07-25" }, "Tasks"),
    note("Rel/Shipped.md", { type: "release", released: "2026-07-01" }), // past but not a deadline
    note("Tasks/Series.md", { type: "task", due: "2026-07-12", repeat: "weekly" }, "Tasks"), // a series never overdue
    note("Loose.md", { when: "2026-07-05" }), // heuristic date, no schema deadline
  ];
  const out = overdueEntries(notes, schema, "2026-07-19");
  assert.deepEqual(
    out.map((e) => [e.path, e.day]),
    [
      ["Tasks/B older.md", "2026-07-10"],
      ["Tasks/A newer.md", "2026-07-15"],
    ]
  );
});

test("overdueEntries: same-day rows tiebreak by title", () => {
  const schema: SchemaConfig = { task: { due: { options: [], kind: "date", notify: true } } };
  const notes = [
    note("Tasks/Zeta.md", { type: "task", due: "2026-07-15" }, "Tasks"),
    note("Tasks/Alpha.md", { type: "task", due: "2026-07-15" }, "Tasks"),
  ];
  assert.deepEqual(
    overdueEntries(notes, schema, "2026-07-19").map((e) => e.title),
    ["Alpha", "Zeta"]
  );
});

test("overdueEntries: no past deadlines → empty, and today/future stay out", () => {
  const schema: SchemaConfig = { task: { due: { options: [], kind: "date", notify: true } } };
  const notes = [
    note("Tasks/Today.md", { type: "task", due: "2026-07-19" }, "Tasks"),
    note("Tasks/Future.md", { type: "task", due: "2026-08-01" }, "Tasks"),
  ];
  assert.deepEqual(overdueEntries(notes, schema, "2026-07-19"), []);
  assert.deepEqual(overdueEntries([], schema, "2026-07-19"), []);
});

test("overdueEntries: a skipped or ended series still never counts", () => {
  const schema: SchemaConfig = { task: { due: { options: [], kind: "date", notify: true } } };
  const notes = [
    // anchor past, series ended before today → repeating entries stay out
    note("Tasks/Ended.md", { type: "task", due: "2026-07-10", repeat: "daily", repeat_until: "2026-07-12" }, "Tasks"),
  ];
  assert.deepEqual(overdueEntries(notes, schema, "2026-07-19"), []);
});

/* ----- optional time-of-day on date props ----- */

test("splitDayTime: day-only, timed, and the T separator", () => {
  assert.deepEqual(splitDayTime("2026-07-19"), { day: "2026-07-19", time: null });
  assert.deepEqual(splitDayTime("2026-07-19 14:30"), { day: "2026-07-19", time: "14:30" });
  assert.deepEqual(splitDayTime("2026-07-19T09:05"), { day: "2026-07-19", time: "09:05" });
  assert.deepEqual(splitDayTime("2026-07-19 00:00"), { day: "2026-07-19", time: "00:00" });
  // A single-digit hour parses and pads, agreeing with parseDateTimeLoose
  assert.deepEqual(splitDayTime("2026-07-19 9:30"), { day: "2026-07-19", time: "09:30" });
  assert.deepEqual(splitDayTime("2026-07-19T9:30"), { day: "2026-07-19", time: "09:30" });
});

test("splitDayTime: bad day or bad time is null, never a partial split", () => {
  assert.equal(splitDayTime("2026-02-30 14:30"), null, "impossible day");
  assert.equal(splitDayTime("2026-07-19 25:00"), null, "hour past 23");
  assert.equal(splitDayTime("2026-07-19 14:60"), null, "minute past 59");
  assert.equal(splitDayTime("2026-07-19 9:5"), null, "unpadded minute");
  assert.equal(splitDayTime("2026-07-19 14:30:00"), null, "seconds are not the grammar");
  assert.equal(splitDayTime("2026-7-19 14:30"), null, "unpadded day");
  assert.equal(splitDayTime("soonish"), null);
  assert.equal(splitDayTime(""), null);
});

/* ----- date ranges ----- */

test("splitDateRange: single dates, spans, and timed spans", () => {
  assert.deepEqual(splitDateRange("2026-09-01"), {
    start: { day: "2026-09-01", time: null },
    end: null,
  });
  assert.deepEqual(splitDateRange("2026-09-01/2026-09-21"), {
    start: { day: "2026-09-01", time: null },
    end: { day: "2026-09-21", time: null },
  });
  assert.deepEqual(splitDateRange("2026-09-01 09:00/2026-09-03 17:00"), {
    start: { day: "2026-09-01", time: "09:00" },
    end: { day: "2026-09-03", time: "17:00" },
  });
  // a same-day timed span is the legitimate "meeting from 09:00 to 17:00"
  assert.deepEqual(splitDateRange("2026-09-01 09:00/2026-09-01 17:00"), {
    start: { day: "2026-09-01", time: "09:00" },
    end: { day: "2026-09-01", time: "17:00" },
  });
});

test("splitDateRange: a reversed or half-written range is not a date at all", () => {
  assert.equal(splitDateRange("2026-09-21/2026-09-01"), null, "end before start");
  assert.equal(splitDateRange("2026-09-01 17:00/2026-09-01 09:00"), null, "end time before start");
  assert.equal(splitDateRange("2026-09-01/"), null, "missing end");
  assert.equal(splitDateRange("/2026-09-01"), null, "missing start");
  assert.equal(splitDateRange("2026-09-01/soon"), null, "unparseable end");
  assert.equal(splitDateRange("2026-09-01/2026-09-05/2026-09-09"), null, "two separators");
});

test("splitDayTime returns the START of a range, so every caller sorts by it", () => {
  assert.deepEqual(splitDayTime("2026-09-01/2026-09-21"), { day: "2026-09-01", time: null });
  assert.deepEqual(splitDayTime("2026-09-01 09:00/2026-09-03 17:00"), {
    day: "2026-09-01",
    time: "09:00",
  });
  // the unpadded-hour normalization runs through the range path too
  assert.deepEqual(splitDayTime("2026-09-01 9:00/2026-09-03 17:00"), {
    day: "2026-09-01",
    time: "09:00",
  });
  assert.equal(splitDayTime("2026-09-21/2026-09-01"), null);
});

test("entriesForNote: a range lands on every covered day, tagged by position", () => {
  const n = note("Calendar/Trip.md", { type: "event", date: "2026-09-01/2026-09-04" }, "Calendar");
  const entries = entriesForNote(n, {});
  assert.deepEqual(
    entries.map((e) => [e.day, e.spanPos]),
    [
      ["2026-09-01", "start"],
      ["2026-09-02", "mid"],
      ["2026-09-03", "mid"],
      ["2026-09-04", "end"],
    ]
  );
  assert.ok(entries.every((e) => e.endDay === "2026-09-04"));
});

test("entriesForNote: a range's time rides only its first day", () => {
  const n = note(
    "Calendar/Conf.md",
    { type: "event", date: "2026-09-01 09:00/2026-09-03 17:00" },
    "Calendar"
  );
  const entries = entriesForNote(n, {});
  assert.deepEqual(
    entries.map((e) => [e.day, e.time ?? null]),
    [
      ["2026-09-01", "09:00"],
      ["2026-09-02", null],
      ["2026-09-03", null],
    ]
  );
  assert.ok(entries.every((e) => e.endTime === "17:00"));
});

test("entriesForNote: a one-day range is a single entry, marked start", () => {
  const n = note("Calendar/Day.md", { type: "event", date: "2026-09-01/2026-09-01" }, "Calendar");
  const entries = entriesForNote(n, {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0].spanPos, "start");
  assert.equal(entries[0].endDay, "2026-09-01");
});

test("entriesForNote: a mis-cased type still gets its schema's date rules (SUB-696)", () => {
  // schema keyed `Release`/`Released`, the note says `type: release` — both
  // sides hand-authored, so the casing must not decide whether the schema applies
  const schema: SchemaConfig = {
    Release: {
      Released: { options: [], kind: "date" },
      contract: { options: [], kind: "file" },
    },
  };
  const n = note("Releases/Vessel.md", {
    type: "release",
    released: "2026-09-01",
    contract: "2026-09-02", // file-kind: date-shaped, but never a calendar entry
  });
  const entries = entriesForNote(n, schema);
  assert.deepEqual(
    entries.map((e) => [e.prop, e.day]),
    [["released", "2026-09-01"]]
  );
});

test("isDeadline / datePropFor fold type and prop case (SUB-696)", () => {
  const schema: SchemaConfig = {
    Release: { Due: { options: [], kind: "date", notify: true }, note: { options: [] } },
  };
  assert.equal(isDeadline(schema, "release", "due"), true);
  assert.equal(isDeadline(schema, "Release", "Due"), true); // exact keys keep working
  assert.equal(isDeadline(schema, "release", "note"), false);
  assert.equal(isDeadline(schema, "track", "due"), false); // absent type stays false
  assert.equal(datePropFor("release", [], schema), "Due");
  // A real note's spelling wins over the schema spelling so a date write
  // updates `due` instead of creating a parallel `Due` frontmatter key.
  const notes = [note("Releases/Vessel.md", { type: "RELEASE", due: "2026-09-01" })];
  assert.equal(datePropFor("release", notes, schema), "due");
});

test("isDeadline counts a lead time standing alone (SUB-842)", () => {
  const schema: SchemaConfig = {
    task: {
      // the engine blesses this shape: heads-up only, nothing on the day
      lead: { options: [], kind: "date", notifyBefore: 3 },
      both: { options: [], kind: "date", notify: true, notifyBefore: 3 },
      off: { options: [], kind: "date" },
      zero: { options: [], kind: "date", notifyBefore: 0 },
      // a lead time on a non-date prop is meaningless — kind still gates
      text: { options: [], notifyBefore: 3 },
    },
  };
  assert.equal(isDeadline(schema, "task", "lead"), true);
  assert.equal(isDeadline(schema, "task", "both"), true);
  assert.equal(isDeadline(schema, "task", "off"), false);
  assert.equal(isDeadline(schema, "task", "zero"), false);
  assert.equal(isDeadline(schema, "task", "text"), false);
});

test("datePropFor folds note types for its usage fallback (SUB-728)", () => {
  const notes = [
    note("Tasks/A.md", { Type: "TASK", Due: "2026-09-01" }, "Tasks"),
    note("Tasks/B.md", { type: "task", due: "2026-09-02" }, "Tasks"),
    note("Tasks/C.md", { type: "Task", DUE: "2026-09-03" }, "Tasks"),
    note("Tasks/D.md", { type: "task", review: "2026-09-04" }, "Tasks"),
    note("Tasks/E.md", { type: "task", review: "2026-09-05" }, "Tasks"),
  ];
  assert.equal(datePropFor("task", notes, {}), "Due", "case variants count together; first spelling wins");
  assert.equal(folderFor("task", notes), "Tasks");
  const entries = calendarEntries(notes, {});
  assert.equal(entries[0].type, "TASK");
  assert.equal(entries[0].prop, "Due");
});

test("dateRangeValue: the three same-day reversals write a parseable range (SUB-631)", () => {
  // 1. peek Time row — typing a start time on `2026-09-01/2026-09-01`
  const timeRow = dateRangeValue("2026-09-01", "09:00", { day: "2026-09-01" });
  assert.equal(timeRow, "2026-09-01 09:00/2026-09-01 09:00");
  // 2. timed-canvas drop — the untimed end of a one-day range, dropped at 16:00
  const drop = dateRangeValue("2026-09-01", "16:00", { day: "2026-09-01", time: undefined });
  assert.equal(drop, "2026-09-01 16:00/2026-09-01 16:00");
  // 3. picker closing a range on the day of an already-timed single date
  const picked = dateRangeValue("2026-09-01", "09:00", { day: "2026-09-01", time: null });
  assert.equal(picked, "2026-09-01 09:00/2026-09-01 09:00");
  for (const v of [timeRow, drop, picked]) {
    assert.ok(splitDateRange(v), `${v} must stay a date value`);
    const entries = entriesForNote(
      note("Calendar/One.md", { type: "event", date: v }, "Calendar"),
      {}
    );
    assert.equal(entries.length, 1, `${v} must still land on the calendar`);
    assert.equal(entries[0].day, "2026-09-01");
  }
});

test("shiftedRangeEnd: a timed span holds its duration to the minute (SUB-1015)", () => {
  const block = { day: "2026-08-10", time: "09:00", endDay: "2026-08-10", endTime: "17:00" };
  // canvas drop an hour later — still 8 hours, not 7
  assert.deepEqual(shiftedRangeEnd(block, { day: "2026-08-10", time: "10:00" }), {
    day: "2026-08-10",
    time: "18:00",
  });
  // dropped past its own stored end — must NOT invert into a 1-hour block
  assert.deepEqual(shiftedRangeEnd(block, { day: "2026-08-10", time: "18:00" }), {
    day: "2026-08-11",
    time: "02:00",
  });
  // the late drop's value round-trips as a real range
  const v = dateRangeValue("2026-08-10", "18:00", { day: "2026-08-11", time: "02:00" });
  assert.equal(v, "2026-08-10 18:00/2026-08-11 02:00");
  assert.ok(splitDateRange(v));
  // a cross-day timed span shifts both halves of the delta
  assert.deepEqual(
    shiftedRangeEnd(
      { day: "2026-08-10", time: "20:00", endDay: "2026-08-12", endTime: "06:00" },
      { day: "2026-08-11", time: "21:30" }
    ),
    { day: "2026-08-13", time: "07:30" }
  );
});

test("shiftedRangeEnd: day-only spans and untimed drops keep whole-day shifts", () => {
  // day-only span: end travels the same number of days
  assert.deepEqual(
    shiftedRangeEnd({ day: "2026-08-10", endDay: "2026-08-13" }, { day: "2026-08-15" }),
    { day: "2026-08-18", time: undefined }
  );
  // month-cell drop keeps the value's time verbatim on the end (time rides along)
  assert.deepEqual(
    shiftedRangeEnd(
      { day: "2026-08-10", time: "09:00", endDay: "2026-08-10", endTime: "17:00" },
      { day: "2026-08-12" }
    ),
    { day: "2026-08-12", time: "17:00" }
  );
  // all-day-strip drop (time cleared): whole-day shift, end time preserved
  assert.deepEqual(
    shiftedRangeEnd(
      { day: "2026-08-10", time: "09:00", endDay: "2026-08-11", endTime: "17:00" },
      { day: "2026-08-10", time: null }
    ),
    { day: "2026-08-11", time: "17:00" }
  );
  // non-span and unparseable endpoints stay null
  assert.equal(shiftedRangeEnd({ day: "2026-08-10" }, { day: "2026-08-12" }), null);
  assert.equal(
    shiftedRangeEnd({ day: "2026-08-10", endDay: "bogus" }, { day: "2026-08-12" }),
    null
  );
});

test("dateRangeValue: two same-day times out of order swap (SUB-631)", () => {
  assert.equal(
    dateRangeValue("2026-09-01", "17:00", { day: "2026-09-01", time: "09:00" }),
    "2026-09-01 09:00/2026-09-01 17:00"
  );
  // a cross-day reversal swaps too, rather than writing an unparseable value
  assert.equal(
    dateRangeValue("2026-09-05", "09:00", { day: "2026-09-01", time: "17:00" }),
    "2026-09-01 17:00/2026-09-05 09:00"
  );
});

test("dateRangeValue: ordinary values are untouched", () => {
  assert.equal(dateRangeValue("2026-09-01"), "2026-09-01");
  assert.equal(dateRangeValue("2026-09-01", "09:00"), "2026-09-01 09:00");
  assert.equal(dateRangeValue("2026-09-01", null, { day: "2026-09-04" }), "2026-09-01/2026-09-04");
  assert.equal(
    dateRangeValue("2026-09-01", "09:00", { day: "2026-09-03", time: "17:00" }),
    "2026-09-01 09:00/2026-09-03 17:00"
  );
  // a day-only end on a LATER day stays day-only — only same-day inherits
  assert.equal(
    dateRangeValue("2026-09-01", "09:00", { day: "2026-09-04" }),
    "2026-09-01 09:00/2026-09-04"
  );
  // a day-only start with a timed same-day end keeps the all-day start
  assert.equal(
    dateRangeValue("2026-09-01", null, { day: "2026-09-01", time: "17:00" }),
    "2026-09-01/2026-09-01 17:00"
  );
});

test("entriesForNote: interior span days are clipped to the window", () => {
  const n = note("Calendar/Long.md", { type: "event", date: "2026-09-01/2026-09-30" }, "Calendar");
  const days = entriesForNote(n, {}, { start: "2026-09-10", end: "2026-09-12" }).map((e) => e.day);
  // the start day always survives — overdue and agenda scans still see it
  assert.deepEqual(days, ["2026-09-01", "2026-09-10", "2026-09-11", "2026-09-12"]);
});

test("entriesForNote: a window >366 days past the range start still gets its days (SUB-1024)", () => {
  // the span cap bounds iterations; counted from the range start it exhausted
  // before ever reaching a far window, blacking out a running multi-year range
  const n = note("Projects/Long.md", { type: "event", date: "2025-06-01/2027-05-31" }, "Projects");
  const days = entriesForNote(n, {}, { start: "2026-08-01", end: "2026-08-31" }).map((e) => e.day);
  assert.equal(days[0], "2025-06-01", "the start day always survives");
  assert.deepEqual(
    days.slice(1, 4),
    ["2026-08-01", "2026-08-02", "2026-08-03"],
    "the window's own slice is emitted"
  );
  assert.equal(days.length, 32, "start + all 31 window days");
});

test("recurrence ignores ranges: one single-day occurrence per step", () => {
  const notes = [
    note(
      "Calendar/Standup.md",
      { type: "event", date: "2026-09-01/2026-09-03", repeat: "weekly" },
      "Calendar"
    ),
  ];
  const entries = calendarEntries(notes, {}, { start: "2026-09-01", end: "2026-09-15" });
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-09-01", "2026-09-08", "2026-09-15"]
  );
  assert.ok(
    entries.every((e) => e.endDay === undefined && e.spanPos === undefined),
    "span metadata is stripped, not multiplied by the cadence"
  );
});

test("overdueEntries: a running range is not late until its END has passed", () => {
  const schema: SchemaConfig = { task: { due: { options: [], kind: "date", notify: true } } };
  const notes = [
    note("Tasks/Running.md", { type: "task", due: "2026-09-01/2026-09-21" }, "Tasks"),
  ];
  assert.deepEqual(overdueEntries(notes, schema, "2026-09-10"), [], "mid-span is not overdue");
  assert.deepEqual(overdueEntries(notes, schema, "2026-09-21"), [], "the end day itself is not");
  const late = overdueEntries(notes, schema, "2026-09-22");
  assert.equal(late.length, 1);
  assert.equal(late[0].day, "2026-09-01", "the overdue row is the span's start");
});

test("entriesForNote keeps a timed value: day split off, time carried", () => {
  const notes = [
    note("Calendar/Gig.md", { type: "event", date: "2026-07-19 14:30", created: "2026-07-01" }, "Calendar"),
    note("Calendar/All day.md", { type: "event", date: "2026-07-19", created: "2026-07-01" }, "Calendar"),
    note("Calendar/Broken.md", { type: "event", date: "2026-07-19 25:00" }, "Calendar"),
  ];
  const entries = entriesForNote(notes[0], {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0].day, "2026-07-19", "the day key stays day-only");
  assert.equal(entries[0].time, "14:30");
  // day-only keeps no time field; a bad time drops the entry like a bad day
  assert.equal(entriesForNote(notes[1], {})[0].time, undefined);
  assert.deepEqual(entriesForNote(notes[2], {}), []);
});

test("timed values qualify via the schema branch and the heuristic alike", () => {
  const schema: SchemaConfig = { task: { due: { options: [], kind: "date" } } };
  const heuristic = calendarEntries([note("a.md", { when: "2026-07-19 08:15" })], {});
  assert.deepEqual(heuristic.map((e) => [e.day, e.time]), [["2026-07-19", "08:15"]]);
  const declared = calendarEntries(
    [note("Tasks/T.md", { type: "task", due: "2026-07-19 08:15" }, "Tasks")],
    schema
  );
  assert.deepEqual(declared.map((e) => [e.prop, e.day, e.time]), [["due", "2026-07-19", "08:15"]]);
});

test("recurrence: the anchor's time carries onto every occurrence", () => {
  const notes = [note("E.md", { date: "2026-07-18 09:00", repeat: "daily" })];
  const entries = calendarEntries(notes, {}, { start: "2026-07-18", end: "2026-07-21" });
  assert.deepEqual(
    entries.map((e) => [e.day, e.time]),
    [
      ["2026-07-18", "09:00"],
      ["2026-07-19", "09:00"],
      ["2026-07-20", "09:00"],
      ["2026-07-21", "09:00"],
    ]
  );
  // repeat_skip/until stay day-only: skipping the occurrence's bare day works
  const skipped = calendarEntries(
    [note("E.md", { date: "2026-07-18 09:00", repeat: "daily", repeat_skip: ["2026-07-19"] })],
    {},
    { start: "2026-07-18", end: "2026-07-20" }
  );
  assert.deepEqual(skipped.map((e) => e.day), ["2026-07-18", "2026-07-20"]);
});

test("overdueEntries: a timed past deadline counts, sorted all-day first then by time", () => {
  const schema: SchemaConfig = { task: { due: { options: [], kind: "date", notify: true } } };
  const notes = [
    note("Tasks/B timed late.md", { type: "task", due: "2026-07-15 18:00" }, "Tasks"),
    note("Tasks/C timed early.md", { type: "task", due: "2026-07-15 09:00" }, "Tasks"),
    note("Tasks/A all day.md", { type: "task", due: "2026-07-15" }, "Tasks"),
    note("Tasks/Timed today.md", { type: "task", due: "2026-07-19 09:00" }, "Tasks"), // today → not overdue
  ];
  const out = overdueEntries(notes, schema, "2026-07-19");
  assert.deepEqual(
    out.map((e) => [e.title, e.time ?? null]),
    [
      ["A all day", null],
      ["C timed early", "09:00"],
      ["B timed late", "18:00"],
    ],
    "same day: all-day first, then timed ascending, before the title tiebreak"
  );
});

test("datePropFor: a prop holding timed values still counts as the type's date prop", () => {
  const notes = [note("a.md", { type: "task", due: "2026-07-20 14:00" })];
  assert.equal(datePropFor("task", notes, {}), "due");
});

test("clampedRangeEnd: an end at or before its start settles on the next slot (SUB-1171)", () => {
  const start = { day: "2026-08-10", time: "09:00" };
  // a resize dragged up past the start — clamped to one snap step, never flipped
  assert.deepEqual(clampedRangeEnd(start, { day: "2026-08-10", time: "07:00" }), {
    day: "2026-08-10",
    time: "09:15",
  });
  // exactly on the start is still too short
  assert.deepEqual(clampedRangeEnd(start, { day: "2026-08-10", time: "09:00" }), {
    day: "2026-08-10",
    time: "09:15",
  });
  // one step out is already legal and passes through untouched
  assert.deepEqual(clampedRangeEnd(start, { day: "2026-08-10", time: "09:15" }), {
    day: "2026-08-10",
    time: "09:15",
  });
  // a later day is legal even at an earlier clock time
  assert.deepEqual(clampedRangeEnd(start, { day: "2026-08-11", time: "02:00" }), {
    day: "2026-08-11",
    time: "02:00",
  });
  // an earlier day never survives — it collapses onto the start's own day
  assert.deepEqual(clampedRangeEnd(start, { day: "2026-08-09", time: "23:00" }), {
    day: "2026-08-10",
    time: "09:15",
  });
});

test("clampedRangeEnd: the floor rolls past midnight when the start is late (SUB-1171)", () => {
  assert.deepEqual(
    clampedRangeEnd({ day: "2026-08-10", time: "23:55" }, { day: "2026-08-10", time: "23:00" }),
    { day: "2026-08-11", time: "00:10" }
  );
  // the clamped value round-trips as a real range
  const v = dateRangeValue("2026-08-10", "23:55", { day: "2026-08-11", time: "00:10" });
  assert.equal(v, "2026-08-10 23:55/2026-08-11 00:10");
  assert.ok(splitDateRange(v));
});

test("clampedRangeEnd: day-only endpoints clamp by day alone (SUB-1171)", () => {
  // no times to compare — a later day stands, an earlier one collapses
  assert.deepEqual(clampedRangeEnd({ day: "2026-08-10" }, { day: "2026-08-12" }), {
    day: "2026-08-12",
    time: undefined,
  });
  assert.deepEqual(clampedRangeEnd({ day: "2026-08-10" }, { day: "2026-08-08" }), {
    day: "2026-08-10",
    time: undefined,
  });
  // an unparseable day can't be reasoned about — the start's day is the safe answer
  assert.deepEqual(clampedRangeEnd({ day: "nonsense", time: "09:00" }, { day: "2026-08-10" }), {
    day: "nonsense",
    time: undefined,
  });
});

test("clampedRangeEnd: a custom minimum honours the caller's grid (SUB-1171)", () => {
  assert.deepEqual(
    clampedRangeEnd({ day: "2026-08-10", time: "09:00" }, { day: "2026-08-10", time: "08:00" }, 30),
    { day: "2026-08-10", time: "09:30" }
  );
});
