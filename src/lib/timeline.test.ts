import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutTimeline,
  parseTimelineConfig,
  timelineData,
  timelineDate,
  timelineTicks,
  type TimelineItem,
} from "./timeline.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { shiftDate } from "./dates.ts";

function note(title: string, props: Record<string, unknown>): NoteMeta {
  return { path: `${title}.md`, stem: title, title, folder: "", props, updated_ms: 0, excerpt: "", sealed: false };
}

const schema: SchemaConfig = {
  release: {
    start: { kind: "date", options: [] },
    end: { kind: "date", options: [] },
    stage: { options: [] },
  },
};

test("parseTimelineConfig reads the strict fence contract", () => {
  assert.deepEqual(
    parseTimelineConfig("source: release\nstart: start\nend: end\nlabel: title\ngroup: stage\nquery: status:live"),
    { source: "release", start: "start", end: "end", label: "title", group: "stage", query: "status:live" }
  );
  assert.throws(() => parseTimelineConfig("source: release\nstart: start"), /label/);
  assert.throws(() => parseTimelineConfig("source: release\nstart: start\nlabel: title\ncolour: red"), /unknown key/);
  assert.throws(() => parseTimelineConfig("source: {{Plan}}\nstart: start\nlabel: title"), /database type/);
});

test("a key given twice is refused, not silently last-wins", () => {
  // Two `start:` lines drew whichever came last, so the band on the page and
  // the band in the fence could disagree with nothing said about it.
  assert.throws(
    () => parseTimelineConfig("source: release\nstart: start\nlabel: title\nstart: begins"),
    /duplicate key "start"/
  );
  // the key is folded before the map write, so the duplicate is too
  assert.throws(
    () => parseTimelineConfig("source: release\nstart: start\nlabel: title\nStart: begins"),
    /duplicate key "Start"/
  );
});

test("timelineDate accepts ISO days and date-times only", () => {
  assert.equal(timelineDate("2026-08-03"), "2026-08-03");
  assert.equal(timelineDate("2026-08-03 10:30"), "2026-08-03");
  assert.equal(timelineDate("2026-08-04T10:00"), "2026-08-04");
  assert.equal(timelineDate("2026-02-30"), null);
  assert.equal(timelineDate("next week"), null);
  // A typo'd day must not be truncated to a false-but-plausible position.
  assert.equal(timelineDate("2026-08-045"), null);
  assert.equal(timelineDate("2026-08-04abc"), null);
  assert.equal(timelineDate("2026-08-04-05"), null);
});

test("a typo'd date is skipped and counted, a date-time is drawn on its day", () => {
  const config = parseTimelineConfig("source: release\nstart: start\nend: end\nlabel: title");
  const result = timelineData(config, [
    note("Typo day", { type: "release", start: "2026-08-045" }),
    note("Trailing junk", { type: "release", start: "2026-08-04abc" }),
    note("Timed", { type: "release", start: "2026-08-04T10:00" }),
  ], schema);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.items.map((item) => [item.label, item.start]), [["Timed", "2026-08-04"]]);
});

test("an empty list reads as unwritten: [] end is a milestone, [] start is undated", () => {
  const config = parseTimelineConfig("source: release\nstart: start\nend: end\nlabel: title");
  const result = timelineData(config, [
    note("Milestone", { type: "release", start: "2026-08-01", end: [] }),
    note("No start", { type: "release", start: [], end: "2026-08-09" }),
  ], schema);
  assert.equal(result.error, null);
  assert.deepEqual(result.items.map((item) => [item.label, item.end]), [["Milestone", null]]);
  assert.equal(result.skipped, 1);
});

test("timelineData filters with the shared query and treats a missing end as a milestone", () => {
  const config = parseTimelineConfig(
    "source: release\nstart: start\nend: end\nlabel: title\ngroup: stage\nquery: status:live"
  );
  const result = timelineData(config, [
    note("Alpha", { type: "release", start: "2026-08-01", end: "2026-08-09", stage: "Mix", status: "live" }),
    note("Beta", { type: "release", start: "2026-08-04", stage: "Master", status: "live" }),
    note("Hidden", { type: "release", start: "2026-08-02", status: "draft" }),
  ], schema);
  assert.equal(result.error, null);
  assert.deepEqual(result.items.map((item) => [item.label, item.end, item.group]), [
    ["Beta", null, "Master"],
    ["Alpha", "2026-08-09", "Mix"],
  ]);
});

test("a schema-declared end with no values yields milestones, not a missing-property error", () => {
  const config = parseTimelineConfig("source: release\nstart: start\nend: end\nlabel: title");
  const result = timelineData(
    config,
    [note("Milestone", { type: "release", start: "2026-08-04" })],
    schema
  );
  assert.equal(result.error, null);
  assert.equal(result.items[0].end, null);
});

test("timelineData names unknown databases and missing bindings", () => {
  const base = parseTimelineConfig("source: release\nstart: start\nlabel: title");
  assert.match(timelineData({ ...base, source: "ghost" }, [], {}).error ?? "", /Unknown database/);
  assert.match(
    timelineData({ ...base, start: "begins" }, [note("A", { type: "release", start: "2026-08-01" })], schema).error ?? "",
    /“begins”/
  );
});

test("timelineData skips invalid written dates and backwards ranges", () => {
  const config = parseTimelineConfig("source: release\nstart: start\nend: end\nlabel: title");
  const result = timelineData(config, [
    note("Good", { type: "release", start: "2026-08-01", end: "2026-08-03" }),
    note("Bad date", { type: "release", start: "soon" }),
    note("Date list", { type: "release", start: ["2026-08-01", "2026-08-02"] }),
    note("End list", { type: "release", start: "2026-08-01", end: ["2026-08-02"] }),
    note("Backwards", { type: "release", start: "2026-08-05", end: "2026-08-02" }),
  ], schema);
  assert.equal(result.items.length, 1);
  assert.equal(result.skipped, 4);
});

test("layoutTimeline packs overlaps, preserves groups, and positions today", () => {
  const items: TimelineItem[] = [
    { path: "a", label: "A", group: "Mix", start: "2026-08-01", end: "2026-08-05" },
    { path: "b", label: "B", group: "Mix", start: "2026-08-04", end: "2026-08-07" },
    { path: "c", label: "C", group: "Mix", start: "2026-08-08", end: null },
    { path: "d", label: "D", group: "Master", start: "2026-08-02", end: null },
  ];
  const layout = layoutTimeline(items, "2026-08-04")!;
  const mix = layout.lanes.find((lane) => lane.key === "Mix")!;
  assert.equal(mix.tracks, 2);
  assert.equal(mix.items[0].track, 0);
  assert.equal(mix.items[1].track, 1);
  assert.equal(mix.items[2].track, 0);
  assert.ok(layout.today !== null && layout.today > 0 && layout.today < 100);
});

test("timelineTicks changes density with span", () => {
  assert.ok(timelineTicks("2026-08-01", "2026-08-31").length >= 4);
  assert.ok(timelineTicks("2026-01-01", "2026-12-31").length >= 10);
  assert.ok(timelineTicks("2023-01-01", "2026-12-31").length <= 16);
});

test("tick density degrades smoothly instead of cliffing", () => {
  const count = (start: string, end: string) => timelineTicks(start, end).length;
  // The old rule cliffed here: 10 weekly ticks at 70 days, 2 monthly at 71.
  for (const [start, end, span] of [
    ["2026-01-01", "2026-03-12", "70d"],
    ["2026-01-01", "2026-03-13", "71d"],
    ["2020-01-01", "2029-12-31", "10y"],
    ["2000-01-01", "2050-01-01", "50y"],
  ] as const) {
    const n = count(start, end);
    assert.ok(n >= 4 && n <= 14, `${span} span drew ${n} ticks, want 4–14`);
  }
  // A short arc still gets day-level ticks.
  const short = timelineTicks("2026-08-01", "2026-08-06");
  assert.ok(short.length >= 4, `5d span drew ${short.length} ticks`);
  assert.equal(short[1].date, shiftDate(short[0].date, 1));
});
