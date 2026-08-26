/** The entry peek's Time row rendered for real (the harness pattern is written
    up in `docs/component-tests.md`).

    The row is a two-part contract and only the first part is visible to tsc:
    what the typed text MEANS (a time, a request for all-day, or a typo the
    field puts back), and that the meaning reaches the pane's write. The bug
    this pins is the middle one — the field's own placeholder says "All day",
    and typing exactly that used to fail the time pattern and silently reset
    the draft, so the only way back to an all-day event was through the date
    row. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { CalEntry } from "./calendar.ts";
import type { NoteMeta } from "./types.ts";

/** the peek portals to the body, so it sits outside the harness container */
const one = (sel: string) => document.body.querySelector(sel);

const PATH = "Events/Studio Block.md";
const PROP = "date";

/** Type into a field: the harness synthesizes clicks only, so the value goes
    in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** commit the field the way a person does — Enter, not a blur into nowhere */
async function pressEnter(field: Element): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** a block drawn on the timed canvas: a start AND an end, which is what made
    the revert impossible before */
function timedBlock(): { entry: CalEntry; note: NoteMeta } {
  return {
    entry: {
      path: PATH,
      title: "Studio Block",
      type: "event",
      prop: PROP,
      day: "2026-08-10",
      time: "09:00",
      endDay: "2026-08-10",
      endTime: "10:30",
      spanPos: "start",
    },
    note: {
      path: PATH,
      stem: "Studio Block",
      title: "Studio Block",
      folder: "Events",
      props: { type: "event", [PROP]: "2026-08-10 09:00/2026-08-10 10:30" },
      updated_ms: 0,
      excerpt: "",
      sealed: false,
    },
  };
}

function peekProps(over: Record<string, unknown> = {}) {
  const { entry, note } = timedBlock();
  return {
    entry,
    note,
    icon: null,
    anchor: { left: 40, top: 120, bottom: 140, width: 80 },
    isOccurrence: false,
    repeatText: "None",
    statusSchema: undefined,
    suppressDismiss: false,
    onClose: () => {},
    onOpen: () => {},
    onRename: () => {},
    onMoveDate: () => {},
    onClearDate: () => {},
    onSetTime: () => {},
    onSetEnd: () => null,
    onSetEndDay: () => {},
    onSetStatus: () => {},
    onRepeatPick: () => {},
    onSkip: () => {},
    onEndSeries: () => {},
    onTrash: () => {},
    ...over,
  };
}

/** render the peek over a timed block and hand back the Time field plus the
    times it asked the pane to write */
async function timeRow(t: Parameters<typeof renderComponent>[0]) {
  const wrote: (string | null)[] = [];
  const { default: CalPeek } = await import("../components/CalPeek.tsx");
  await renderComponent(
    t,
    h(CalPeek, peekProps({ onSetTime: (time: string | null) => wrote.push(time) }))
  );
  const field = one(".cal-peek-time");
  assert.ok(field, "the Time row renders a field");
  assert.equal((field as HTMLInputElement).value, "09:00", "showing the stored time");
  return { field, wrote };
}

test("emptying the Time field asks for all-day", async (t) => {
  const { field, wrote } = await timeRow(t);
  await type(field, "");
  await pressEnter(field);
  assert.deepEqual(wrote, [null]);
});

test("typing the field's own “All day” placeholder asks for all-day too", async (t) => {
  const { field, wrote } = await timeRow(t);
  await type(field, "All day");
  await pressEnter(field);
  assert.deepEqual(wrote, [null]);
  // and the field doesn't sit there reading "All day" as if it were a value
  assert.equal((field as HTMLInputElement).value, "");
});

test("a typo writes nothing and puts the stored time back", async (t) => {
  const { field, wrote } = await timeRow(t);
  await type(field, "half nine");
  await pressEnter(field);
  assert.deepEqual(wrote, []);
  assert.equal((field as HTMLInputElement).value, "09:00");
});

test("a real time still commits, padded", async (t) => {
  const { field, wrote } = await timeRow(t);
  await type(field, "9:45");
  await pressEnter(field);
  assert.deepEqual(wrote, ["09:45"]);
  assert.equal((field as HTMLInputElement).value, "09:45");
});

test("a continuation chip's Time row carries the stored start, and edits it", async (t) => {
  // the day-2 chip of a span dragged past midnight renders all-day, so its
  // entry has no time of its own — but the row edits the stored start, and
  // an empty field here is what made the stranded event look uneditable
  const wrote: (string | null)[] = [];
  const props = peekProps({ onSetTime: (time: string | null) => wrote.push(time) });
  const { time: _time, ...tail } = props.entry;
  props.entry = {
    ...tail,
    day: "2026-08-11",
    endDay: "2026-08-11",
    endTime: "01:00",
    spanPos: "end",
  } as CalEntry;
  props.note = {
    ...props.note,
    props: { type: "event", [PROP]: "2026-08-10 20:00/2026-08-11 01:00" },
  };
  const { default: CalPeek } = await import("../components/CalPeek.tsx");
  await renderComponent(t, h(CalPeek, props));
  const field = one(".cal-peek-time");
  assert.ok(field, "the Time row renders on the continuation chip");
  assert.equal((field as HTMLInputElement).value, "20:00", "showing the stored start");
  await type(field, "19:30");
  await pressEnter(field);
  assert.deepEqual(wrote, ["19:30"]);
});
