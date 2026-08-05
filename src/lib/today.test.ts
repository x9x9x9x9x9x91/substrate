import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { pickedDay, todayData, todayTitle, TODAY_PROP } from "./today.ts";

function note(
  path: string,
  props: Record<string, unknown>,
  updated_ms = 0,
  folder = ""
): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return {
    path,
    stem,
    title: (props.title as string) ?? stem,
    folder,
    props,
    updated_ms,
    excerpt: "",
    sealed: false,
  };
}

const schema: SchemaConfig = {
  task: {
    status: {
      options: [
        { value: "todo", color: "yellow" },
        { value: "doing", color: "blue" },
      ],
    },
    due: { options: [], kind: "date", notify: true },
    brief: { options: [], kind: "file" },
  },
  event: {
    date: { options: [], kind: "date" },
  },
};

const TODAY = "2026-07-17"; // a Friday

test("todayTitle is the confident header", () => {
  assert.equal(todayTitle("2026-07-17"), "Friday, July 17");
  assert.equal(todayTitle("2026-12-31"), "Thursday, December 31");
  assert.equal(todayTitle("not-a-date"), "not-a-date");
});

test("pickedDay reads the pick prop, tolerating an optional time", () => {
  assert.equal(pickedDay(note("A.md", { today: TODAY })), TODAY);
  assert.equal(pickedDay(note("B.md", { today: `${TODAY} 09:00` })), TODAY);
  assert.equal(pickedDay(note("C.md", { today: "soon" })), null);
  assert.equal(pickedDay(note("D.md", { created: TODAY })), null);
});

test("scheduled holds today's plain entries, all-day first then timed (SUB-270)", () => {
  const notes = [
    note("Calendar/Late.md", { type: "event", date: `${TODAY} 18:00` }, 0, "Calendar"),
    note("Calendar/Gig.md", { type: "event", date: TODAY }, 0, "Calendar"),
    note("Calendar/Early.md", { type: "event", date: `${TODAY} 09:00` }, 0, "Calendar"),
    note("Tasks/Due today.md", { type: "task", status: "todo", due: TODAY }, 0, "Tasks"),
    note("Calendar/Tomorrow.md", { type: "event", date: "2026-07-18" }, 0, "Calendar"),
  ];
  const d = todayData(notes, schema, TODAY);
  assert.deepEqual(
    d.scheduled.map((i) => `${i.title}:${i.time ?? "all-day"}:${i.deadline}`),
    ["Gig:all-day:false", "Early:09:00:false", "Late:18:00:false"],
    "deadlines and other days stay out"
  );
  assert.deepEqual(
    d.due.map((i) => i.title),
    ["Due today"],
    "the due-today task lands in its own lane"
  );
});

test("the due lane fronts overdue oldest-first, today's deadlines after", () => {
  const notes = [
    note("Tasks/Due today.md", { type: "task", status: "todo", due: TODAY }, 0, "Tasks"),
    note("Tasks/Late.md", { type: "task", status: "todo", due: "2026-07-15" }, 0, "Tasks"),
    note("Tasks/Later.md", { type: "task", status: "todo", due: "2026-07-16" }, 0, "Tasks"),
    note("Tasks/Future.md", { type: "task", status: "todo", due: "2026-07-20" }, 0, "Tasks"),
    // plain past dates are history, not overdue — only schema deadlines count
    note("Calendar/Gig.md", { type: "event", date: "2026-07-14" }, 0, "Calendar"),
  ];
  const d = todayData(notes, schema, TODAY);
  assert.deepEqual(
    d.due.map((i) => `${i.title}:${i.day}`),
    [`Late:2026-07-15`, `Later:2026-07-16`, `Due today:${TODAY}`]
  );
  assert.deepEqual(d.scheduled, []);
});

test("done today stays visible in its lane (SUB-205); done overdue never nags", () => {
  const notes = [
    note("Tasks/Done today.md", { type: "task", status: "done", due: TODAY }, 0, "Tasks"),
    note("Tasks/Done late.md", { type: "task", status: "done", due: "2026-07-15" }, 0, "Tasks"),
    note("Calendar/Wrapped.md", { type: "event", date: TODAY, status: "cancelled" }, 0, "Calendar"),
  ];
  const d = todayData(notes, schema, TODAY);
  assert.deepEqual(
    d.due.map((i) => `${i.title}:${i.status}`),
    ["Done today:done"],
    "the payoff rides along for the pane to dim"
  );
  assert.deepEqual(
    d.scheduled.map((i) => i.title),
    ["Wrapped"],
    "a cancelled event keeps its scheduled slot, dimmed"
  );
});

test("a repeating series lands in today's lanes but never goes overdue (SUB-174)", () => {
  const notes = [
    note("Calendar/Water plants.md", { type: "event", date: "2026-07-15", repeat: "every 2 days" }, 0, "Calendar"),
    note("Tasks/Weekly review.md", { type: "task", status: "todo", due: "2026-07-10", repeat: "weekly" }, 0, "Tasks"),
  ];
  const d = todayData(notes, schema, TODAY);
  assert.deepEqual(d.scheduled.map((i) => i.title), ["Water plants"]);
  assert.deepEqual(
    d.due.map((i) => i.title),
    ["Weekly review"],
    "the series occurrence due today shows — its past anchors don't pile up"
  );
});

test("picking moves the note out of the candidate lanes into Picked", () => {
  const notes = [
    note("Tasks/Picked task.md", { type: "task", status: "todo", due: TODAY, [TODAY_PROP]: TODAY }, 0, "Tasks"),
    note("Calendar/Picked gig.md", { type: "event", date: `${TODAY} 20:00`, [TODAY_PROP]: TODAY }, 0, "Calendar"),
    note("Tasks/Open task.md", { type: "task", status: "todo", due: TODAY }, 0, "Tasks"),
  ];
  const d = todayData(notes, schema, TODAY);
  assert.deepEqual(
    d.picked.map((p) => p.note.title),
    ["Picked task", "Picked gig"],
    "all-day picks first, timed after (SUB-270 parity)"
  );
  assert.equal(d.picked[0].time, undefined);
  assert.equal(d.picked[1].time, "20:00", "the pick keeps its own entry's time");
  assert.deepEqual(
    d.due.map((i) => i.title),
    ["Open task"],
    "the picked task's due entry moved lanes with it — no double rows"
  );
  assert.deepEqual(d.scheduled, []);
  // the pick prop itself never becomes a candidate entry either
  assert.ok(d.due.every((i) => i.prop !== TODAY_PROP));
});

test("a stale pick is a leftover, freshest first — never silently carried", () => {
  const notes = [
    note("Ideas/Old pick.md", { type: "diary", [TODAY_PROP]: "2026-07-10" }, 0, "Ideas"),
    note("Ideas/Yesterday pick.md", { type: "diary", [TODAY_PROP]: "2026-07-16" }, 0, "Ideas"),
    note("Ideas/Future pick.md", { type: "diary", [TODAY_PROP]: "2026-07-20" }, 0, "Ideas"),
  ];
  const d = todayData(notes, schema, TODAY);
  assert.deepEqual(
    d.leftovers.map((l) => `${l.note.title}:${l.day}`),
    ["Yesterday pick:2026-07-16", "Old pick:2026-07-10"]
  );
  assert.deepEqual(d.picked, [], "a stale pick is not today's agenda");
  assert.deepEqual(d.scheduled, [], "the future pick minds its own day");
});

test("an undated vault renders three quiet lanes, not a crash", () => {
  const d = todayData([note("Plain.md", { created: "2026-01-01" })], schema, TODAY);
  assert.deepEqual(d.scheduled, []);
  assert.deepEqual(d.due, []);
  assert.deepEqual(d.picked, []);
  assert.deepEqual(d.leftovers, []);
});
