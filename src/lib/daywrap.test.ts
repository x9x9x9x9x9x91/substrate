import { test } from "node:test";
import assert from "node:assert/strict";
import { appendWrapLine, wrapLine, wrapPlan, wrapWorthDoing } from "./daywrap.ts";
import type { LeftoverItem, PickedItem } from "./today.ts";
import type { NoteMeta } from "./types.ts";

function note(title: string, props: Record<string, unknown> = {}): NoteMeta {
  return {
    path: `Inbox/${title}.md`,
    stem: title,
    title,
    folder: "Inbox",
    props,
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const picked = (title: string, status?: string): PickedItem => ({
  note: note(title, status ? { status } : {}),
});
const leftover = (title: string): LeftoverItem => ({ note: note(title), day: "2026-08-21" });

test("the plan splits today's picks by their status", () => {
  const plan = wrapPlan(
    [picked("Bounce stems", "done"), picked("Call the label"), picked("Old idea", "cancelled")],
    [leftover("Yesterday's thing")]
  );
  // a dropped thing is not a done thing — the line a human reads back must
  // not count the two together
  assert.deepEqual(plan.done, ["Bounce stems"]);
  assert.deepEqual(plan.cancelled, ["Old idea"]);
  assert.deepEqual(plan.carried, ["Call the label"]);
  assert.deepEqual(plan.clearing, [
    { path: "Inbox/Yesterday's thing.md", title: "Yesterday's thing" },
  ]);
});

test("the line names what was dropped apart from what was done", () => {
  const plan = wrapPlan(
    [picked("Bounce stems", "done"), picked("Old idea", "cancelled"), picked("Call the label")],
    []
  );
  assert.equal(
    wrapLine(plan),
    "- Day wrap: 1 done — Bounce stems; 1 dropped — Old idea; 1 carried over — Call the label"
  );
  // a day of nothing but dropped picks still has something to say
  assert.equal(wrapWorthDoing(wrapPlan([picked("Old idea", "cancelled")], [])), true);
});

test("an empty day is not worth wrapping", () => {
  const plan = wrapPlan([], []);
  assert.equal(wrapWorthDoing(plan), false);
  assert.equal(wrapLine(plan), "");
  assert.equal(wrapWorthDoing(wrapPlan([], [leftover("Stale")])), true);
});

test("the line counts first, then names", () => {
  const plan = wrapPlan([picked("Bounce stems", "done"), picked("Call the label")], []);
  assert.equal(wrapLine(plan), "- Day wrap: 1 done — Bounce stems; 1 carried over — Call the label");
});

test("the line says how many leftovers it cleared, singular and plural", () => {
  assert.equal(wrapLine(wrapPlan([], [leftover("A")])), "- Day wrap: 1 leftover cleared");
  assert.equal(
    wrapLine(wrapPlan([], [leftover("A"), leftover("B")])),
    "- Day wrap: 2 leftovers cleared"
  );
});

test("a long list stops naming and starts counting", () => {
  const plan = wrapPlan(
    ["A", "B", "C", "D", "E", "F"].map((t) => picked(t, "done")),
    []
  );
  assert.equal(wrapLine(plan), "- Day wrap: 6 done — A, B, C, D +2 more");
});

test("the line joins the journal's own writing without eating it", () => {
  assert.equal(appendWrapLine("", "- Day wrap: x"), "- Day wrap: x\n");
  assert.equal(appendWrapLine("Woke up late.\n\n", "- Day wrap: x"), "Woke up late.\n\n- Day wrap: x\n");
});
