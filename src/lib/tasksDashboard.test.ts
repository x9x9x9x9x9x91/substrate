import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TASK_STALE_DAYS,
  buildTasksDashboard,
  taskAgeDays,
  taskIsNow,
  taskIsSnoozed,
  taskPriorityWeight,
  tasksDashboardConfig,
} from "./tasksDashboard.ts";
import type { NoteMeta } from "./types.ts";

const NOW = new Date(2026, 7, 1, 12);

function note(title: string, props: Record<string, unknown>, path = `Tasks/${title}.md`): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: "Tasks",
    props,
    updated_ms: 0,
    excerpt: "",
  };
}

test("filters to open tasks with case/whitespace-insensitive type and completion status", () => {
  const model = buildTasksDashboard(
    [
      note("open", { type: " task ", status: "doing", created: "2026-07-30" }),
      note("done", { type: "task", status: " DONE ", created: "2026-01-01" }),
      note("cancelled", { type: "task", status: "Cancelled", created: "2026-01-01" }),
      note("event", { type: "event", status: "todo", created: "2026-01-01" }),
    ],
    {},
    NOW
  );
  assert.equal(model.total, 1);
  assert.equal(model.groups[0]?.rows[0]?.title, "open");
});

test("area allowlist accepts YAML lists or comma text, matches case-insensitively, and orders groups", () => {
  const notes = [
    note("studio", { type: "task", area: "studio", created: "2026-07-01" }),
    note("admin", { type: "task", area: "Admin", created: "2026-07-01" }),
    note("label", { type: "task", area: "Label", created: "2026-07-01" }),
  ];
  const yaml = buildTasksDashboard(notes, { areas: ["Admin", "Studio"] }, NOW);
  assert.deepEqual(yaml.groups.map((group) => group.area), ["Admin", "Studio"]);
  assert.deepEqual(yaml.groups.flatMap((group) => group.rows.map((row) => row.title)), [
    "admin",
    "studio",
  ]);

  const comma = buildTasksDashboard(notes, { areas: " studio, LABEL " }, NOW);
  assert.deepEqual(comma.groups.map((group) => group.area), ["studio", "LABEL"]);
});

test("without an allowlist groups every area alphabetically and puts unassigned last", () => {
  const model = buildTasksDashboard(
    [
      note("none", { type: "task", created: "2026-07-01" }),
      note("z", { type: "task", area: "Zulu", created: "2026-07-01" }),
      note("a", { type: "task", area: "alpha", created: "2026-07-01" }),
    ],
    {},
    NOW
  );
  assert.deepEqual(model.groups.map((group) => group.area), ["alpha", "Zulu", "Unassigned"]);
});

test("created age is strict, local-calendar based, DST-safe, and clamps future dates", () => {
  assert.equal(taskAgeDays("2026-07-02", NOW), 30);
  assert.equal(taskAgeDays("2026-08-03", NOW), 0);
  assert.equal(taskAgeDays("2026-02-30", NOW), null);
  assert.equal(taskAgeDays("2026-07-01 10:00", NOW), null);
  assert.equal(taskAgeDays(undefined, NOW), null);
  assert.equal(taskAgeDays(123, NOW), null);
});

test("priority weights are case-insensitive and unknown priorities stay conservative", () => {
  assert.equal(taskPriorityWeight(" HIGH "), 3);
  assert.equal(taskPriorityWeight("Medium"), 2);
  assert.equal(taskPriorityWeight("low"), 1);
  assert.equal(taskPriorityWeight("urgent"), 1);
  assert.equal(taskPriorityWeight(undefined), 1);
});

test("age×priority order is stable and deterministic through score ties", () => {
  const input = [
    note("Zulu tie", { type: "task", area: "A", priority: "high", created: "2026-07-22" }),
    note("Alpha tie", { type: "task", area: "A", priority: "medium", created: "2026-07-17" }),
    note("Older low", { type: "task", area: "A", priority: "low", created: "2026-06-22" }),
    note("Winner", { type: "task", area: "A", priority: "HIGH", created: "2026-07-12" }),
  ];
  const before = structuredClone(input);
  const model = buildTasksDashboard(input, {}, NOW);
  assert.deepEqual(
    model.groups[0]?.rows.map((row) => [row.title, row.score]),
    [
      ["Winner", 60],
      ["Older low", 40],
      ["Alpha tie", 30],
      ["Zulu tie", 30],
    ]
  );
  assert.deepEqual(input, before, "input notes and props are not mutated");
});

test("stale threshold is inclusive; invalid settings use the documented default", () => {
  assert.deepEqual(tasksDashboardConfig({ stale_days: "14", areas: "A" }), {
    staleDays: 14,
    areas: ["A"],
  });
  for (const invalid of [0, -1, 1.5, "0", "2.5", "nope", undefined]) {
    assert.equal(tasksDashboardConfig({ stale_days: invalid }).staleDays, DEFAULT_TASK_STALE_DAYS);
  }

  const model = buildTasksDashboard(
    [
      note("boundary", { type: "task", created: "2026-07-18" }),
      note("young", { type: "task", created: "2026-07-19" }),
      note("bad date", { type: "task", created: "2026-13-40" }),
      note("missing date", { type: "task" }),
    ],
    { stale_days: 14 },
    NOW
  );
  const rows = model.groups[0]?.rows ?? [];
  assert.equal(rows.find((row) => row.title === "boundary")?.stale, true);
  assert.equal(rows.find((row) => row.title === "young")?.stale, false);
  assert.equal(rows.find((row) => row.title === "bad date")?.finding, "undated");
  assert.equal(rows.find((row) => row.title === "missing date")?.score, 0);
  assert.equal(model.attention, 3);
});

test("now accepts YAML true and the string form, nothing else (SUB-786)", () => {
  assert.equal(taskIsNow(true), true);
  assert.equal(taskIsNow(" TRUE "), true);
  assert.equal(taskIsNow("false"), false);
  assert.equal(taskIsNow(false), false);
  assert.equal(taskIsNow("yes"), false);
  assert.equal(taskIsNow(undefined), false);
});

test("now rows pin to a cross-area focus list, carry no findings, and leave groups (SUB-786)", () => {
  const model = buildTasksDashboard(
    [
      note("pinned old", { type: "task", area: "Studio", now: true, created: "2026-05-01" }),
      note("pinned undated", { type: "task", area: "Label", now: "true" }),
      note("later stale", { type: "task", area: "Studio", created: "2026-05-01" }),
      note("later fresh", { type: "task", area: "Studio", created: "2026-07-30" }),
    ],
    {},
    NOW
  );
  // stale + undated rows pinned to Now raise nothing; the one Later stale row does
  assert.deepEqual(model.nowRows.map((row) => row.title), ["pinned old", "pinned undated"]);
  assert.deepEqual(model.nowRows.map((row) => row.finding), [null, null]);
  assert.equal(model.attention, 1);
  assert.deepEqual(model.groups.map((group) => group.area), ["Studio"]);
  assert.deepEqual(
    model.groups[0]?.rows.map((row) => row.title),
    ["later stale", "later fresh"]
  );
  assert.equal(model.total, 4);
});

test("snoozed_until hides strict future dates only; malformed values never hide a task (SUB-786)", () => {
  // NOW is 2026-08-01 local
  assert.equal(taskIsSnoozed("2026-08-02", NOW), true);
  assert.equal(taskIsSnoozed("2026-08-01", NOW), false);
  assert.equal(taskIsSnoozed("2026-07-31", NOW), false);
  assert.equal(taskIsSnoozed("2026-02-30", NOW), false);
  assert.equal(taskIsSnoozed("soon", NOW), false);
  assert.equal(taskIsSnoozed(undefined, NOW), false);

  const model = buildTasksDashboard(
    [
      note("parked", { type: "task", area: "A", created: "2026-05-01", snoozed_until: "2026-09-01" }),
      note("woke today", { type: "task", area: "A", created: "2026-05-01", snoozed_until: "2026-08-01" }),
      note("open", { type: "task", area: "A", created: "2026-07-30" }),
    ],
    {},
    NOW
  );
  assert.equal(model.snoozed, 1);
  assert.equal(model.total, 2);
  assert.deepEqual(
    model.groups[0]?.rows.map((row) => row.title),
    ["woke today", "open"]
  );
});

test("snoozed tasks outside the area allowlist do not count as snoozed (SUB-786)", () => {
  const model = buildTasksDashboard(
    [
      note("in-area parked", { type: "task", area: "Studio", snoozed_until: "2026-09-01" }),
      note("off-area parked", { type: "task", area: "Admin", snoozed_until: "2026-09-01" }),
    ],
    { areas: ["Studio"] },
    NOW
  );
  assert.equal(model.snoozed, 1);
  assert.equal(model.total, 0);
});
