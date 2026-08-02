import { test } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta, SchemaConfig } from "./types.ts";
import { agendaPayload, isComplete, isDeadline } from "./agenda.ts";

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
  };
}

const schema: SchemaConfig = {
  task: {
    due: { options: [], kind: "date", notify: true },
    quiet: { options: [], kind: "date" },
  },
  release: {
    released: { options: [], kind: "date" },
  },
};

test("isDeadline needs a notify-flagged date prop", () => {
  assert.equal(isDeadline(schema, "task", "due"), true);
  assert.equal(isDeadline(schema, "task", "quiet"), false, "date kind without notify");
  assert.equal(isDeadline(schema, "release", "released"), false);
  assert.equal(isDeadline(schema, "task", "unknown"), false);
  assert.equal(isDeadline(schema, "ghost", "due"), false);
  assert.equal(
    isDeadline({ task: { due: { options: [], notify: true } } }, "task", "due"),
    false,
    "notify without date kind is not a deadline"
  );
});

test("isComplete reads done/cancelled, case-insensitive and trimmed (SUB-205)", () => {
  assert.equal(isComplete("done"), true);
  assert.equal(isComplete("Done"), true, "case-insensitive");
  assert.equal(isComplete(" DONE "), true, "trimmed");
  assert.equal(isComplete("cancelled"), true);
  assert.equal(isComplete("Cancelled"), true);
  assert.equal(isComplete("todo"), false);
  assert.equal(isComplete("doing"), false);
  assert.equal(isComplete("in review"), false);
  assert.equal(isComplete(""), false);
  assert.equal(isComplete(undefined), false);
});

test("complete deadlines never count as overdue; todo/doing/statusless still do", () => {
  const notes = [
    note("Tasks/Shipped.md", { type: "task", status: "done", due: "2026-07-15", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Dropped.md", { type: "task", status: "cancelled", due: "2026-07-14", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Shouty.md", { type: "task", status: " DONE ", due: "2026-07-13", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Late.md", { type: "task", status: "todo", due: "2026-07-15", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Also late.md", { type: "task", status: "doing", due: "2026-07-10", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Statusless late.md", { type: "task", due: "2026-07-09", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.overdue, 3, "done/cancelled never count, however cased or padded");
  assert.equal(p.items.length, 0);
});

test("a task done today stays on the agenda carrying its status", () => {
  const notes = [
    note("Tasks/Wrapped.md", { type: "task", status: "done", due: "2026-07-17", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.deepEqual(
    p.items.map((i) => `${i.title}:${i.status}:${i.deadline}`),
    ["Wrapped:done:true"],
    "visible today, status threaded, still schema-deadline — the pane drops the dot"
  );
  assert.equal(p.overdue, 0);
});

test("today lists events and due tasks, plain entries before deadlines", () => {
  const notes = [
    note("Calendar/Listening session.md", { type: "event", date: "2026-07-17", created: "2026-07-01" }, "Calendar"),
    note("Tasks/Approve artwork.md", { type: "task", due: "2026-07-17", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Read only.md", { type: "task", quiet: "2026-07-17", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Tomorrow.md", { type: "task", due: "2026-07-18", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.today, "2026-07-17");
  assert.deepEqual(
    p.items.map((i) => i.title),
    ["Listening session", "Read only", "Approve artwork"]
  );
  assert.deepEqual(
    p.items.map((i) => i.deadline),
    [false, false, true]
  );
  assert.equal(p.overdue, 0, "future deadlines are not overdue");
});

test("overdue counts only passed deadlines, never plain past dates", () => {
  const notes = [
    note("Tasks/Late.md", { type: "task", due: "2026-07-15", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Also late.md", { type: "task", due: "2026-07-10", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Quiet past.md", { type: "task", quiet: "2026-07-01", created: "2026-07-01" }, "Tasks"),
    note("Slow Bloom EP.md", { type: "release", released: "2026-06-19", created: "2026-07-01" }),
    note("Old note.md", { created: "2026-01-01" }),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.overdue, 2);
  assert.equal(p.items.length, 0);
});

test("a note dated twice today yields one row per date prop", () => {
  const notes = [
    note("Tasks/Double.md", { type: "task", due: "2026-07-17", quiet: "2026-07-17", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.items.length, 2);
  assert.deepEqual(
    p.items.map((i) => `${i.prop}:${i.deadline}`),
    ["quiet:false", "due:true"]
  );
});

test("undated and malformed dates are ignored", () => {
  const notes = [
    note("Tasks/Undated.md", { type: "task", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Someday.md", { type: "task", due: "someday", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.items.length, 0);
  assert.equal(p.overdue, 0);
});

test("a repeating series due today shows, and is never overdue (SUB-174)", () => {
  const notes = [
    note("Tasks/Standup.md", { type: "task", due: "2026-07-10", repeat: "daily", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.deepEqual(p.items.map((i) => i.title), ["Standup"]);
  assert.equal(p.items[0].repeating, true);
  assert.equal(p.items[0].deadline, true);
  assert.equal(p.overdue, 0, "a series anchored in the past always has a next occurrence");
});

test("a repeating series that ended before today shows nothing and counts nothing", () => {
  const notes = [
    note("Tasks/Standup.md", { type: "task", due: "2026-07-10", repeat: "daily", repeat_until: "2026-07-15", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.items.length, 0);
  assert.equal(p.overdue, 0);
});

test("non-repeating overdue is unchanged next to a repeating series", () => {
  const notes = [
    note("Tasks/Late.md", { type: "task", due: "2026-07-15", created: "2026-07-01" }, "Tasks"),
    note("Tasks/Standup.md", { type: "task", due: "2026-07-10", repeat: "daily", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.overdue, 1, "only the non-repeating late deadline counts");
  assert.deepEqual(p.items.map((i) => i.title), ["Standup"]);
});

test("timed entries sort after all-day ones, ascending by time (SUB-270)", () => {
  const notes = [
    note("Calendar/Late one.md", { type: "event", date: "2026-07-17 18:00", created: "2026-07-01" }, "Calendar"),
    note("Tasks/Due all day.md", { type: "task", due: "2026-07-17", created: "2026-07-01" }, "Tasks"),
    note("Calendar/Early one.md", { type: "event", date: "2026-07-17 09:00", created: "2026-07-01" }, "Calendar"),
    note("Calendar/All day.md", { type: "event", date: "2026-07-17", created: "2026-07-01" }, "Calendar"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.deepEqual(
    p.items.map((i) => [i.title, i.time ?? null]),
    [
      ["All day", null],
      ["Due all day", null],
      ["Early one", "09:00"],
      ["Late one", "18:00"],
    ],
    "all-day first (classic plain-before-deadline order inside), timed ascending after"
  );
});

test("a timed past deadline counts as overdue on its day part (SUB-270)", () => {
  const notes = [
    note("Tasks/Late call.md", { type: "task", due: "2026-07-15 14:00", created: "2026-07-01" }, "Tasks"),
  ];
  const p = agendaPayload(notes, schema, "2026-07-17");
  assert.equal(p.overdue, 1);
  assert.equal(p.items.length, 0);
});
