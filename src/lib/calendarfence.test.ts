import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calendarSourceDesc,
  calendarTitle,
  countEntriesInMonth,
  dbCalendarEntries,
  entriesByDay,
  monthWindow,
  parseCalendarBlocks,
  parseCalendarConfig,
  sheetCalendarEntries,
  sortEntries,
} from "./calendarfence.ts";
import type { CalEntry } from "./calendar.ts";
import { evaluateSheet, parseSheet } from "./sheet.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

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

const schema: SchemaConfig = {
  release: { released: { kind: "date", options: [] }, status: { options: [] } },
};

// the grid the fence renders for July 2026 — Mon 29 Jun … Sun 2 Aug
const july = monthWindow(2026, 6);

// ---------- config parsing ----------

test("parses a database fence with every key", () => {
  const c = parseCalendarConfig(
    ["# a comment", "source: release", "date: released", "label: title", "query: status:live"].join(
      "\n"
    )
  );
  assert.deepEqual(c.source, { kind: "db", type: "release" });
  assert.equal(c.date, "released");
  assert.equal(c.label, "title");
  assert.equal(c.query, "status:live");
});

test("parses a sheet source and keeps its spelling", () => {
  const c = parseCalendarConfig("source: {{ Holdings }}\ndate: bought");
  assert.deepEqual(c.source, { kind: "sheet", name: "Holdings" });
  assert.equal(c.label, null);
  assert.equal(c.query, null);
});

test("keys are case-insensitive and blank lines are ignored", () => {
  const c = parseCalendarConfig("\nSOURCE: release\n\nDate: released\n");
  assert.deepEqual(c.source, { kind: "db", type: "release" });
  assert.equal(c.date, "released");
});

test("missing source and missing date each throw", () => {
  assert.throws(() => parseCalendarConfig("date: released"), /missing required key "source"/);
  assert.throws(() => parseCalendarConfig("source: release"), /missing required key "date"/);
});

test("unknown keys and unparsable lines throw", () => {
  assert.throws(() => parseCalendarConfig("source: release\ndate: due\ncolour: red"), /unknown key "colour"/);
  assert.throws(() => parseCalendarConfig("source: release\ndate: due\nnonsense"), /can't parse line: nonsense/);
});

test("a query on a sheet source throws — sheets have no filter bar", () => {
  assert.throws(
    () => parseCalendarConfig("source: {{Holdings}}\ndate: bought\nquery: status:live"),
    /query only applies to a database source/
  );
});

test("collects every fence in body order and never throws", () => {
  const body = [
    "# Home",
    "```calendar",
    "source: release",
    "date: released",
    "```",
    "prose",
    "```calendar",
    "date: released",
    "```",
    "```chart",
    "source: release",
    "```",
  ].join("\n");
  const blocks = parseCalendarBlocks(body);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].error, null);
  assert.equal(blocks[0].config?.date, "released");
  assert.equal(blocks[1].config, null);
  assert.match(blocks[1].error as string, /missing required key "source"/);
});

test("CRLF fences parse", () => {
  const blocks = parseCalendarBlocks("```calendar\r\nsource: release\r\ndate: released\r\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].error, null);
});

// ---------- window ----------

test("the month window covers the whole drawn grid, adjacent days included", () => {
  assert.equal(july.start, "2026-06-29");
  assert.equal(july.end, "2026-08-02");
  const feb = monthWindow(2026, 1);
  assert.ok(feb.start < "2026-02-01");
  assert.ok(feb.end >= "2026-02-28");
});

// ---------- database entries ----------

test("places notes of the type on their date-prop days", () => {
  const notes = [
    note("Releases/A.md", { type: "release", released: "2026-07-04" }),
    note("Releases/B.md", { type: "release", released: "2026-07-19 18:30" }),
    note("Notes/C.md", { type: "note", released: "2026-07-04" }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries, error } = dbCalendarEntries(c, notes, schema, july);
  assert.equal(error, null);
  assert.deepEqual(
    entries.map((e) => [e.day, e.title, e.time]),
    [
      ["2026-07-04", "A", undefined],
      ["2026-07-19", "B", "18:30"],
    ]
  );
});

test("only the configured date property lands on the grid", () => {
  const notes = [note("R/A.md", { type: "release", released: "2026-07-04", due: "2026-07-10" })];
  const both: SchemaConfig = {
    release: { released: { kind: "date", options: [] }, due: { kind: "date", options: [] } },
  };
  const c = parseCalendarConfig("source: release\ndate: due");
  const { entries } = dbCalendarEntries(c, notes, both, july);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-07-10"]
  );
});

test("query narrows the note set before placement", () => {
  const notes = [
    note("R/A.md", { type: "release", released: "2026-07-04", status: "live" }),
    note("R/B.md", { type: "release", released: "2026-07-06", status: "draft" }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released\nquery: status:live");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["A"]
  );
});

test("a query that matches nothing is an empty month, not an error", () => {
  const notes = [note("R/A.md", { type: "release", released: "2026-07-04", status: "live" })];
  const c = parseCalendarConfig("source: release\ndate: released\nquery: status:shelved");
  const { entries, error } = dbCalendarEntries(c, notes, schema, july);
  assert.equal(error, null);
  assert.deepEqual(entries, []);
});

test("label overrides the chip text; a blank label falls back to the title", () => {
  const notes = [
    note("R/A.md", { type: "release", released: "2026-07-04", catalog: "UG-001" }),
    note("R/B.md", { type: "release", released: "2026-07-05", catalog: "  " }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released\nlabel: catalog");
  const { entries, error } = dbCalendarEntries(c, notes, schema, july);
  assert.equal(error, null);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["UG-001", "B"]
  );
});

test("entries carry the note path so a click can open it", () => {
  const notes = [note("Releases/A.md", { type: "release", released: "2026-07-04" })];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.equal(entries[0].path, "Releases/A.md");
});

// ---------- database errors ----------

test("an unknown database errors", () => {
  const c = parseCalendarConfig("source: nope\ndate: released");
  const { entries, error } = dbCalendarEntries(c, [], schema, july);
  assert.deepEqual(entries, []);
  assert.match(error as string, /no database “nope”/);
});

test("a misspelled date property errors and lists the real ones", () => {
  const notes = [note("R/A.md", { type: "release", released: "2026-07-04" })];
  const c = parseCalendarConfig("source: release\ndate: releaseed");
  const { error } = dbCalendarEntries(c, notes, schema, july);
  assert.match(error as string, /no date property “releaseed” on release \(has: released\)/);
});

test("a misspelled label property errors and lists what the type has", () => {
  const notes = [note("R/A.md", { type: "release", released: "2026-07-04", catalog: "UG-001" })];
  const c = parseCalendarConfig("source: release\ndate: released\nlabel: catalogue");
  const { error } = dbCalendarEntries(c, notes, schema, july);
  assert.match(error as string, /no property “catalogue” on release \(has: type, released, catalog\)/);
});

test("a schema-declared date property binds even when no note carries it yet", () => {
  const notes = [note("R/A.md", { type: "release" })];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries, error } = dbCalendarEntries(c, notes, schema, july);
  assert.equal(error, null);
  assert.deepEqual(entries, []);
});

test("an empty database is an empty grid, not a binding error", () => {
  const c = parseCalendarConfig("source: release\ndate: anything");
  const { entries, error } = dbCalendarEntries(c, [], schema, july);
  assert.equal(error, null);
  assert.deepEqual(entries, []);
});

// ---------- recurrence (vault-format §5.7) ----------

test("a weekly note fills the whole month it repeats through", () => {
  const notes = [
    note("R/Standup.md", { type: "release", released: "2026-07-01", repeat: "weekly" }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"]
  );
  assert.ok(entries.every((e) => e.repeating === true));
});

test("a series that started before the window still fills it", () => {
  const notes = [note("R/Rent.md", { type: "release", released: "2025-01-05", repeat: "monthly" })];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-07-05"]
  );
});

test("repeat_until truncates the series inside the grid", () => {
  const notes = [
    note("R/Standup.md", {
      type: "release",
      released: "2026-07-01",
      repeat: "weekly",
      repeat_until: "2026-07-16",
    }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-07-01", "2026-07-08", "2026-07-15"]
  );
});

test("repeat_skip drops just the listed occurrences", () => {
  const notes = [
    note("R/Standup.md", {
      type: "release",
      released: "2026-07-01",
      repeat: "weekly",
      repeat_skip: ["2026-07-08", "2026-07-22"],
    }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-07-01", "2026-07-15", "2026-07-29"]
  );
});

test("repeat_until is never itself placed on the grid", () => {
  const notes = [
    note("R/Standup.md", {
      type: "release",
      released: "2026-07-01",
      repeat: "weekly",
      repeat_until: "2026-07-09",
    }),
  ];
  const c = parseCalendarConfig("source: release\ndate: repeat_until");
  const { error } = dbCalendarEntries(c, notes, schema, july);
  assert.match(error as string, /no date property “repeat_until”/);
});

test("a repeating note's occurrences all carry its label", () => {
  const notes = [
    note("R/Standup.md", {
      type: "release",
      released: "2026-07-01",
      repeat: "weekly",
      catalog: "UG-Weekly",
    }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released\nlabel: catalog");
  const { entries } = dbCalendarEntries(c, notes, schema, july);
  assert.ok(entries.length > 1);
  assert.ok(entries.every((e) => e.title === "UG-Weekly"));
});

// ---------- sheet entries ----------

const SHEET = [
  "```csv",
  "Name,Bought,Kind",
  "BTC,2026-07-06,crypto",
  "ETF,2026-07-20,etf",
  "Cash,n/a,cash",
  "```",
  "",
].join("\n");

function sheet(md: string) {
  const model = parseSheet(md);
  return { model, ev: evaluateSheet(model, () => null) };
}

test("a sheet source places rows by their date column", () => {
  const { model, ev } = sheet(SHEET);
  const c = parseCalendarConfig("source: {{Holdings}}\ndate: bought");
  const { entries, error } = sheetCalendarEntries(c, "Sheets/Holdings.md", model, ev);
  assert.equal(error, null);
  assert.deepEqual(
    entries.map((e) => [e.day, e.title, e.path]),
    [
      ["2026-07-06", "BTC", "Sheets/Holdings.md"],
      ["2026-07-20", "ETF", "Sheets/Holdings.md"],
    ]
  );
});

test("a sheet label picks another column", () => {
  const { model, ev } = sheet(SHEET);
  const c = parseCalendarConfig("source: {{Holdings}}\ndate: bought\nlabel: kind");
  const { entries } = sheetCalendarEntries(c, "Sheets/Holdings.md", model, ev);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["crypto", "etf"]
  );
});

test("a misspelled sheet column errors with the column list", () => {
  const { model, ev } = sheet(SHEET);
  const c = parseCalendarConfig("source: {{Holdings}}\ndate: brought");
  const { error } = sheetCalendarEntries(c, "Sheets/Holdings.md", model, ev);
  assert.match(error as string, /no date column “brought” on Holdings \(has: Name, Bought, Kind\)/);
});

// ---------- the foot's count ----------

test("the foot counts the month itself for a database source, across a page flip (SUB-965)", () => {
  // neither of these is bounded by the grid window: calendarEntries only
  // window-bounds spans and recurrence, so a far-off single-date note comes
  // back whatever month is drawn
  const notes = [
    note("Releases/Jul.md", { type: "release", released: "2026-07-04" }),
    note("Releases/JulLate.md", { type: "release", released: "2026-07-30" }),
    note("Releases/Aug.md", { type: "release", released: "2026-08-11" }),
    note("Releases/Old.md", { type: "release", released: "2020-01-02" }),
  ];
  const c = parseCalendarConfig("source: release\ndate: released");

  const jul = dbCalendarEntries(c, notes, schema, july);
  assert.ok(jul.entries.length > 2, "the raw list carries out-of-month notes");
  assert.equal(countEntriesInMonth(jul.entries, 2026, 6), 2, "July counts its own two");

  // page forward: the same unbounded list, a different month named
  const aug = dbCalendarEntries(c, notes, schema, monthWindow(2026, 7));
  assert.equal(countEntriesInMonth(aug.entries, 2026, 7), 1, "August counts its own one");
  // the 30 Jul note is drawn in August's leading cells but is not "this month"
  assert.ok(
    aug.entries.some((e) => e.day === "2026-07-30"),
    "the adjacent-month cell is still drawn"
  );
});

test("the foot counts the month itself for a sheet source, across a page flip (SUB-965)", () => {
  // a sheet source takes no window at all — without the month filter a 3-row
  // sheet would read "3 entries this month" in every month of the year
  const { model, ev } = sheet(SHEET);
  const c = parseCalendarConfig("source: {{Holdings}}\ndate: bought");
  const { entries } = sheetCalendarEntries(c, "Sheets/Holdings.md", model, ev);
  assert.equal(entries.length, 2, "both dated rows are placed");
  assert.equal(countEntriesInMonth(entries, 2026, 6), 2, "July has both");
  assert.equal(countEntriesInMonth(entries, 2026, 7), 0, "August has neither");
  assert.equal(countEntriesInMonth(entries, 2025, 6), 0, "and the year matters too");
});

// ---------- shaping ----------

function e(day: string, title: string, time?: string): CalEntry {
  return { path: `${title}.md`, title, type: "release", prop: "released", day, ...(time ? { time } : {}) };
}

test("entries sort by day, then time, then title", () => {
  const sorted = sortEntries([e("2026-07-04", "B", "09:00"), e("2026-07-04", "A"), e("2026-07-01", "Z")]);
  assert.deepEqual(
    sorted.map((x) => x.title),
    ["Z", "A", "B"]
  );
});

test("entriesByDay buckets by ISO day in order", () => {
  const byDay = entriesByDay(sortEntries([e("2026-07-04", "A"), e("2026-07-04", "B"), e("2026-07-05", "C")]));
  assert.deepEqual([...byDay.keys()], ["2026-07-04", "2026-07-05"]);
  assert.equal(byDay.get("2026-07-04")?.length, 2);
});

test("the title is derived, and the foot names the source", () => {
  const db = parseCalendarConfig("source: release\ndate: released");
  assert.equal(calendarTitle(db), "Release by released");
  assert.equal(calendarSourceDesc(db), "database: release");
  const sh = parseCalendarConfig("source: {{Holdings}}\ndate: bought");
  assert.equal(calendarSourceDesc(sh), "sheet: Holdings");
});
