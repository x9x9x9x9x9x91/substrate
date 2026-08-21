import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TASK_STALE_DAYS,
  buildTasksDashboard,
  dueChipLabel,
  priorityFallbackColor,
  taskAgeDays,
  taskDueBucket,
  taskDueDays,
  taskIsNow,
  taskIsSnoozed,
  taskPriorityWeight,
  tasksDashboardConfig,
  parseTasksSort,
  parseTasksView,
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
    sealed: false,
  };
}

/** The area sections only — the spine's Overdue/Due today/Now come first. */
const areaSections = (model: ReturnType<typeof buildTasksDashboard>) =>
  model.sections.filter((s) => s.kind === "area");

const sectionNamed = (model: ReturnType<typeof buildTasksDashboard>, label: string) =>
  model.sections.find((s) => s.label === label);

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
  assert.equal(areaSections(model)[0]?.rows[0]?.title, "open");
});

test("reads task note properties case-insensitively", () => {
  const model = buildTasksDashboard(
    [
      note("cased", {
        Type: "task",
        Status: "todo",
        Created: "2026-07-30",
        Due: "2026-08-01",
        Priority: "high",
        Area: "Studio",
      }),
      note("done", { Type: "task", Status: "done" }),
      note("pinned", { type: "task", Now: true }),
      note("parked", { type: "task", Snoozed_Until: "2026-09-01" }),
    ],
    {},
    NOW
  );

  const cased = sectionNamed(model, "Due today")?.rows[0];
  assert.deepEqual(
    cased && {
      title: cased.title,
      area: cased.area,
      priority: cased.priority,
      created: cased.created,
      due: cased.due,
    },
    {
      title: "cased",
      area: "Studio",
      priority: "high",
      created: "2026-07-30",
      due: "2026-08-01",
    }
  );
  assert.deepEqual(sectionNamed(model, "Now")?.rows.map((row) => row.title), ["pinned"]);
  assert.deepEqual(model.snoozedRows.map((row) => row.title), ["parked"]);
  assert.equal(model.total, 2);
});

test("area allowlist accepts YAML lists or comma text, matches case-insensitively, and orders groups", () => {
  const notes = [
    note("studio", { type: "task", area: "studio", created: "2026-07-01" }),
    note("admin", { type: "task", area: "Admin", created: "2026-07-01" }),
    note("label", { type: "task", area: "Label", created: "2026-07-01" }),
  ];
  const yaml = buildTasksDashboard(notes, { areas: ["Admin", "Studio"] }, NOW);
  assert.deepEqual(areaSections(yaml).map((s) => s.label), ["Admin", "Studio"]);
  assert.deepEqual(areaSections(yaml).flatMap((s) => s.rows.map((row) => row.title)), [
    "admin",
    "studio",
  ]);

  const comma = buildTasksDashboard(notes, { areas: " studio, LABEL " }, NOW);
  assert.deepEqual(areaSections(comma).map((s) => s.label), ["studio", "LABEL"]);
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
  assert.deepEqual(areaSections(model).map((s) => s.label), ["alpha", "Zulu", "Unassigned"]);
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

test("stale threshold is inclusive; invalid settings use the documented default", () => {
  assert.deepEqual(tasksDashboardConfig({ stale_days: "14", areas: "A" }), {
    staleDays: 14,
    staleChips: true,
    areas: ["A"],
    view: "list",
    sort: "urgency",
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
  const rows = areaSections(model)[0]?.rows ?? [];
  assert.equal(rows.find((row) => row.title === "boundary")?.stale, true);
  assert.equal(rows.find((row) => row.title === "young")?.stale, false);
  assert.equal(rows.find((row) => row.title === "bad date")?.finding, "undated");
  assert.equal(rows.find((row) => row.title === "missing date")?.ageDays, null);
  // boundary is stale, both undated rows are undated — three findings in all
  assert.deepEqual(
    rows.filter((row) => row.finding !== null).map((row) => [row.title, row.finding]).sort(),
    [
      ["bad date", "undated"],
      ["boundary", "stale"],
      ["missing date", "undated"],
    ]
  );
});

/* some notes just aren't touched. Precedence, in order:
   the per-note override wins over everything; a board's own `stale_days`
   wins over the global toggle; the toggle is the default under both. */

const findings = (model: ReturnType<typeof buildTasksDashboard>) =>
  areaSections(model)
    .flatMap((s) => s.rows)
    .filter((row) => row.finding !== null)
    .map((row) => [row.title, row.finding])
    .sort();

const AGE_NOTES = [
  note("old", { type: "task", created: "2026-01-01" }),
  note("fresh", { type: "task", created: "2026-07-31" }),
  note("undated", { type: "task" }),
];

test("the global toggle off suppresses age findings board-wide (SUB-1125)", () => {
  assert.deepEqual(findings(buildTasksDashboard(AGE_NOTES, {}, NOW, true)), [
    ["old", "stale"],
    ["undated", "undated"],
  ]);

  const off = buildTasksDashboard(AGE_NOTES, {}, NOW, false);
  assert.deepEqual(findings(off), []);
  // the flag follows the chip: the board must not claim rot it isn't showing
  assert.deepEqual(
    areaSections(off)
      .flatMap((s) => s.rows)
      .filter((row) => row.stale)
      .map((row) => row.title),
    []
  );
  assert.equal(off.config.staleChips, false);
  // the rows themselves are untouched — this hides a diagnostic, never a task
  assert.equal(off.total, 3);
  assert.equal(
    areaSections(off).flatMap((s) => s.rows).find((row) => row.title === "old")?.ageDays,
    212
  );
});

test("a board's own stale_days wins over the global toggle (SUB-1125)", () => {
  const model = buildTasksDashboard(AGE_NOTES, { stale_days: 14 }, NOW, false);
  assert.equal(model.config.staleChips, true);
  assert.equal(model.config.staleDays, 14);
  assert.deepEqual(findings(model), [
    ["old", "stale"],
    ["undated", "undated"],
  ]);
  // a typo isn't a request: it reads as unset, so the toggle still governs
  // and the threshold falls back to the documented default
  const typo = buildTasksDashboard(AGE_NOTES, { stale_days: "soon" }, NOW, false);
  assert.equal(typo.config.staleChips, false);
  assert.equal(typo.config.staleDays, DEFAULT_TASK_STALE_DAYS);
  assert.deepEqual(findings(typo), []);
});

test("stale: never exempts one note for good, like a pin (SUB-1125)", () => {
  const model = buildTasksDashboard(
    [
      note("evergreen", { type: "task", created: "2026-01-01", stale: "never" }),
      note("evergreen-bool", { type: "task", created: "2026-01-01", stale: false }),
      note("evergreen-undated", { type: "task", stale: "Never" }),
      ...AGE_NOTES,
    ],
    // even with a board that has explicitly asked for chips at a tight
    // threshold, the note's own opt-out is the last word
    { stale_days: 7 },
    NOW
  );
  assert.deepEqual(findings(model), [
    ["old", "stale"],
    ["undated", "undated"],
  ]);
  const rows = areaSections(model).flatMap((s) => s.rows);
  assert.equal(rows.find((row) => row.title === "evergreen")?.stale, false);
  assert.equal(rows.find((row) => row.title === "evergreen")?.ageDays, 212);
  assert.equal(rows.length, 6);
});

test("an unreadable stale value ages normally (SUB-1125)", () => {
  for (const value of ["yes", "nope", true, 0, 1, [], {}, null, undefined]) {
    const model = buildTasksDashboard(
      [note("old", { type: "task", created: "2026-01-01", stale: value })],
      {},
      NOW
    );
    assert.deepEqual(findings(model), [["old", "stale"]], `stale: ${JSON.stringify(value)}`);
  }
});

test("now accepts YAML true and the string form, nothing else (SUB-786)", () => {
  assert.equal(taskIsNow(true), true);
  assert.equal(taskIsNow(" TRUE "), true);
  assert.equal(taskIsNow("false"), false);
  assert.equal(taskIsNow(false), false);
  assert.equal(taskIsNow("yes"), false);
  assert.equal(taskIsNow(undefined), false);
});

test("now rows pin to a cross-area focus section, carry no findings, and leave groups (SUB-786)", () => {
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
  const now = sectionNamed(model, "Now");
  assert.deepEqual(now?.rows.map((row) => row.title), ["pinned old", "pinned undated"]);
  assert.deepEqual(now?.rows.map((row) => row.finding), [null, null]);
  assert.equal(model.nowCount, 2);
  // the one Later stale row is the only finding on the board
  assert.deepEqual(
    model.sections.flatMap((s) => s.rows).filter((row) => row.finding !== null).map((row) => row.title),
    ["later stale"]
  );
  assert.deepEqual(areaSections(model).map((s) => s.label), ["Studio"]);
  assert.deepEqual(
    areaSections(model)[0]?.rows.map((row) => row.title),
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
    areaSections(model)[0]?.rows.map((row) => row.title),
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

/* —————————————————————— due dates lead —————————————————————— */

test("due days count local calendar days and bucket around today (SUB-870)", () => {
  // NOW is 2026-08-01 local
  assert.equal(taskDueDays("2026-07-31", NOW), -1);
  assert.equal(taskDueDays("2026-08-01", NOW), 0);
  assert.equal(taskDueDays("2026-08-08", NOW), 7);
  // a timed due value still buckets by its day
  assert.equal(taskDueDays("2026-08-01 09:30", NOW), 0);
  // malformed values are simply undated — never urgent, never hidden
  assert.equal(taskDueDays("2026-02-30", NOW), null);
  assert.equal(taskDueDays("next week", NOW), null);
  assert.equal(taskDueDays(undefined, NOW), null);
  assert.equal(taskDueDays(20260801, NOW), null);

  assert.equal(taskDueBucket(-1), "overdue");
  assert.equal(taskDueBucket(0), "today");
  assert.equal(taskDueBucket(1), "upcoming");
  assert.equal(taskDueBucket(null), null);
});

test("the spine is Overdue, Due today, Now, then areas — empty sections are omitted (SUB-870)", () => {
  const model = buildTasksDashboard(
    [
      note("late", { type: "task", area: "Label", due: "2026-07-20", created: "2026-07-01" }),
      note("today", { type: "task", area: "Studio", due: "2026-08-01", created: "2026-07-01" }),
      note("pinned", { type: "task", area: "Studio", now: true, created: "2026-07-01" }),
      note("someday", { type: "task", area: "Admin", due: "2026-09-09", created: "2026-07-01" }),
      note("no date", { type: "task", area: "Admin", created: "2026-07-01" }),
    ],
    {},
    NOW
  );
  assert.deepEqual(
    model.sections.map((s) => [s.kind, s.label]),
    [
      ["overdue", "Overdue"],
      ["today", "Due today"],
      ["now", "Now"],
      ["area", "Admin"],
    ]
  );
  assert.equal(model.overdue, 1);
  assert.equal(model.dueToday, 1);
  assert.equal(model.nowCount, 1);
  // Studio's only rows went to Due today and Now, so the group disappears
  assert.deepEqual(areaSections(model).map((s) => s.label), ["Admin"]);
  assert.deepEqual(sectionNamed(model, "Admin")?.rows.map((r) => r.title), ["someday", "no date"]);

  const empty = buildTasksDashboard([note("solo", { type: "task", area: "A" })], {}, NOW);
  assert.deepEqual(empty.sections.map((s) => s.kind), ["area"]);
});

test("urgency outranks the Now pin: a late pinned task shows under Overdue (SUB-870)", () => {
  const model = buildTasksDashboard(
    [
      note("pinned late", { type: "task", area: "Studio", now: true, due: "2026-07-25" }),
      note("pinned due today", { type: "task", area: "Studio", now: true, due: "2026-08-01" }),
      note("pinned undated", { type: "task", area: "Studio", now: true }),
    ],
    {},
    NOW
  );
  assert.deepEqual(sectionNamed(model, "Overdue")?.rows.map((r) => r.title), ["pinned late"]);
  assert.deepEqual(sectionNamed(model, "Due today")?.rows.map((r) => r.title), ["pinned due today"]);
  assert.deepEqual(sectionNamed(model, "Now")?.rows.map((r) => r.title), ["pinned undated"]);
  assert.equal(model.nowCount, 1);
  // a row never appears twice, and never falls out of the board
  assert.equal(model.total, 3);
  assert.equal(model.sections.reduce((n, s) => n + s.rows.length, 0), 3);
});

test("ranking inside a section is due bucket → priority → age, with rot only a tiebreaker (SUB-870)", () => {
  const input = [
    // same area, no due dates: priority now leads where age×priority used to
    note("Old low", { type: "task", area: "A", priority: "low", created: "2026-01-01" }),
    note("Young high", { type: "task", area: "A", priority: "high", created: "2026-07-31" }),
    note("Old medium", { type: "task", area: "A", priority: "medium", created: "2026-02-01" }),
    note("Young medium", { type: "task", area: "A", priority: "medium", created: "2026-07-30" }),
    // a due date beats every undated row in the same group
    note("Upcoming low", { type: "task", area: "A", priority: "low", due: "2026-08-20" }),
  ];
  const before = structuredClone(input);
  const model = buildTasksDashboard(input, {}, NOW);
  assert.deepEqual(
    areaSections(model)[0]?.rows.map((row) => row.title),
    ["Upcoming low", "Young high", "Old medium", "Young medium", "Old low"]
  );
  assert.deepEqual(input, before, "input notes and props are not mutated");

  // inside one due bucket, ties fall through priority → age → title
  const overdue = buildTasksDashboard(
    [
      note("later day medium", { type: "task", area: "A", priority: "medium", due: "2026-07-31" }),
      note("earlier day low", { type: "task", area: "A", priority: "low", due: "2026-06-01" }),
      note("zulu high", { type: "task", area: "A", priority: "high", due: "2026-07-30", created: "2026-07-01" }),
      note("alpha high", { type: "task", area: "A", priority: "high", due: "2026-07-30", created: "2026-07-01" }),
    ],
    {},
    NOW
  );
  assert.deepEqual(
    sectionNamed(overdue, "Overdue")?.rows.map((row) => row.title),
    ["alpha high", "zulu high", "later day medium", "earlier day low"]
  );
});

test("a malformed due date leaves the row in its area group rather than hiding it (SUB-870)", () => {
  const model = buildTasksDashboard(
    [
      note("impossible", { type: "task", area: "A", due: "2026-02-30", created: "2026-07-01" }),
      note("prose", { type: "task", area: "A", due: "sometime soon", created: "2026-07-01" }),
      note("real", { type: "task", area: "A", due: "2026-07-01", created: "2026-07-01" }),
    ],
    {},
    NOW
  );
  assert.equal(model.total, 3);
  const rows = areaSections(model)[0]?.rows ?? [];
  assert.deepEqual(rows.map((r) => r.title), ["impossible", "prose"]);
  assert.deepEqual(rows.map((r) => r.due), [null, null]);
  assert.deepEqual(rows.map((r) => r.dueBucket), [null, null]);
  assert.deepEqual(sectionNamed(model, "Overdue")?.rows.map((r) => r.title), ["real"]);
});

test("snoozed rows keep their wake day and queue soonest-first (SUB-870)", () => {
  const model = buildTasksDashboard(
    [
      note("late wake", { type: "task", area: "A", snoozed_until: "2026-09-01" }),
      note("soon wake", { type: "task", area: "A", snoozed_until: "2026-08-05" }),
      note("awake", { type: "task", area: "A" }),
    ],
    {},
    NOW
  );
  assert.deepEqual(
    model.snoozedRows.map((row) => [row.title, row.snoozedUntil]),
    [
      ["soon wake", "2026-08-05"],
      ["late wake", "2026-09-01"],
    ]
  );
  assert.equal(model.snoozed, 2);
  // parked rows are not part of the visible board
  assert.equal(model.total, 1);
  assert.equal(model.sections.reduce((n, s) => n + s.rows.length, 0), 1);
});

test("a snoozed row that is also overdue stays parked until it wakes (SUB-870)", () => {
  const model = buildTasksDashboard(
    [
      note("parked and late", {
        type: "task",
        area: "A",
        due: "2026-07-01",
        snoozed_until: "2026-08-20",
      }),
    ],
    {},
    NOW
  );
  assert.equal(model.overdue, 0);
  assert.equal(model.sections.length, 0);
  assert.deepEqual(model.snoozedRows.map((r) => [r.title, r.dueBucket]), [
    ["parked and late", "overdue"],
  ]);
});

test("priority falls back to the roster colors only where a schema doesn't (SUB-870)", () => {
  assert.equal(priorityFallbackColor(" HIGH "), "red");
  assert.equal(priorityFallbackColor("Medium"), "yellow");
  assert.equal(priorityFallbackColor("low"), "gray");
  assert.equal(priorityFallbackColor("urgent"), undefined);
  assert.equal(priorityFallbackColor(undefined), undefined);
});

test("due chip labels read Today, day-month in-year, and carry the year beyond it (SUB-870)", () => {
  assert.equal(dueChipLabel("2026-08-01", 0, NOW), "Today");
  assert.equal(dueChipLabel("2026-06-15", -47, NOW), "15 Jun");
  assert.equal(dueChipLabel("2027-01-04", 156, NOW), "4 Jan 27");
  assert.equal(dueChipLabel("nonsense", 3, NOW), "nonsense");
});

test("cased Areas/Stale_Days keys still configure (SUB-921)", () => {
  assert.deepEqual(tasksDashboardConfig({ Areas: "A", Stale_Days: "14" }), {
    areas: ["A"],
    staleDays: 14,
    staleChips: true,
    view: "list",
    sort: "urgency",
  });
});

test("view and sort props fold case/whitespace and fall back on unknowns (SUB-933)", () => {
  assert.equal(parseTasksView(" Board "), "board");
  assert.equal(parseTasksView("list"), "list");
  assert.equal(parseTasksView("kanban"), "list");
  assert.equal(parseTasksView(undefined), "list");
  assert.equal(parseTasksSort(" Priority "), "priority");
  assert.equal(parseTasksSort("DUE"), "due");
  assert.equal(parseTasksSort("age"), "age");
  assert.equal(parseTasksSort("rot"), "urgency");
  assert.equal(parseTasksSort(undefined), "urgency");
});

test("sort=priority leads with weight; due bucket and age stay as tiebreakers (SUB-933)", () => {
  const model = buildTasksDashboard(
    [
      note("late low", { type: "task", area: "A", priority: "low", due: "2026-07-30", created: "2026-07-01" }),
      note("upcoming high", { type: "task", area: "A", priority: "high", due: "2026-08-09", created: "2026-07-20" }),
      note("late high", { type: "task", area: "A", priority: "high", due: "2026-07-25", created: "2026-07-20" }),
    ],
    { sort: "priority" },
    NOW
  );
  // the spine still sections by urgency; inside Overdue priority now leads
  const overdue = sectionNamed(model, "Overdue");
  assert.deepEqual(overdue?.rows.map((r) => r.title), ["late high", "late low"]);
  // the board column shows the full re-ranking: both highs above the low
  assert.deepEqual(model.columns[0]?.rows.map((r) => r.title), [
    "late high",
    "upcoming high",
    "late low",
  ]);
});

test("sort=due orders soonest-first with undated rows last (SUB-933)", () => {
  const model = buildTasksDashboard(
    [
      note("undated high", { type: "task", area: "A", priority: "high", created: "2026-07-01" }),
      note("next week", { type: "task", area: "A", priority: "low", due: "2026-08-06", created: "2026-07-01" }),
      note("yesterday", { type: "task", area: "A", priority: "low", due: "2026-07-31", created: "2026-07-01" }),
      // same upcoming bucket as "next week", sooner but lower-ranked: urgency
      // would put "later high" first on priority, so this pair is what proves
      // the due comparator actually ran rather than falling through to it
      note("later high", { type: "task", area: "A", priority: "high", due: "2026-08-20", created: "2026-07-01" }),
    ],
    { sort: "due" },
    NOW
  );
  assert.deepEqual(model.columns[0]?.rows.map((r) => r.title), [
    "yesterday",
    "next week",
    "later high",
    "undated high",
  ]);
});

test("sort=age leads with the oldest created date (SUB-933)", () => {
  const model = buildTasksDashboard(
    [
      note("young urgent", { type: "task", area: "A", priority: "high", due: "2026-07-30", created: "2026-07-30" }),
      note("ancient", { type: "task", area: "A", priority: "low", created: "2026-02-01" }),
    ],
    { sort: "age" },
    NOW
  );
  assert.deepEqual(model.columns[0]?.rows.map((r) => r.title), ["young urgent", "ancient"].reverse());
});

test("board columns regroup every visible row by area — urgency claims nothing (SUB-933)", () => {
  const model = buildTasksDashboard(
    [
      note("late", { type: "task", area: "Label", due: "2026-07-25", created: "2026-07-01" }),
      note("pinned", { type: "task", area: "Studio", now: true, created: "2026-07-01" }),
      note("plain", { type: "task", area: "Label", created: "2026-07-01" }),
      note("parked", { type: "task", area: "Label", snoozed_until: "2026-09-01", created: "2026-07-01" }),
    ],
    {},
    NOW
  );
  // the list spine pulled `late` into Overdue and `pinned` into Now…
  assert.equal(sectionNamed(model, "Overdue")?.rows.length, 1);
  assert.equal(sectionNamed(model, "Now")?.rows.length, 1);
  // …but the columns keep them home; the snoozed row stays off both views
  assert.deepEqual(model.columns.map((c) => c.area), ["Label", "Studio"]);
  assert.deepEqual(model.columns[0]?.rows.map((r) => r.title), ["late", "plain"]);
  assert.deepEqual(model.columns[1]?.rows.map((r) => r.title), ["pinned"]);
});

test("an allowlist keeps empty columns as drop targets, in the list's order (SUB-933)", () => {
  const model = buildTasksDashboard(
    [note("one", { type: "task", area: "Studio", created: "2026-07-01" })],
    { areas: ["Label", "Studio", "Admin"] },
    NOW
  );
  assert.deepEqual(model.columns.map((c) => c.area), ["Label", "Studio", "Admin"]);
  assert.deepEqual(model.columns.map((c) => c.rows.length), [0, 1, 0]);
});

test("without an allowlist only populated areas hold columns, Unassigned last (SUB-933)", () => {
  const model = buildTasksDashboard(
    [
      note("none", { type: "task", created: "2026-07-01" }),
      note("z", { type: "task", area: "Zulu", created: "2026-07-01" }),
      note("a", { type: "task", area: "alpha", created: "2026-07-01" }),
    ],
    {},
    NOW
  );
  assert.deepEqual(model.columns.map((c) => c.area), ["alpha", "Zulu", "Unassigned"]);
});

test("an areas allowlist that matches nothing counts the work it hid", () => {
  const notes = [
    note("Mix bounce", { type: "task", area: "Studio", created: "2026-07-01" }),
    note("File receipts", { type: "task", area: "Admin", created: "2026-07-01" }),
  ];
  // the audit's case: a board whose allowlist is a typo. Every open task is
  // still open; none of them is on this board.
  const typo = buildTasksDashboard(notes, { areas: ["No Such Area"] }, NOW);
  assert.equal(typo.total, 0);
  assert.equal(typo.filtered, 2);

  // an allowlist that matches, with nothing open in it, is a different fact
  const done = buildTasksDashboard([], { areas: ["Studio"] }, NOW);
  assert.equal(done.total, 0);
  assert.equal(done.filtered, 0);

  // and a board with no allowlist never reports hidden work
  const all = buildTasksDashboard(notes, {}, NOW);
  assert.equal(all.total, 2);
  assert.equal(all.filtered, 0);
});
