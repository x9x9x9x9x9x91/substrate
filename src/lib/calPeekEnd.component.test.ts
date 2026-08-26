/** The entry peek's Ends row rendered for real (the harness pattern is written
    up in `docs/component-tests.md`).

    What it pins is who GETS the row. It used to belong to timed entries only,
    which left a multi-day all-day span — a trip, a festival, a run of studio
    days — with no field anywhere in the app for its closing hour: the date
    picker is day-only by design, so the hour was simply unreachable. The row
    now appears for any value that crosses days, the typed hour lands on the
    span's closing day, and the start stays all-day. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { CalEntry } from "./calendar.ts";
import type { NoteMeta } from "./types.ts";

/** the peek portals to the body, so it sits outside the harness container */
const one = (sel: string) => document.body.querySelector(sel);

const PATH = "Events/Studio Week.md";
const PROP = "date";

async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(field: Element): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** the peek as the pane renders it, over whatever the note actually stores.
    `over` carries the entry fields the value implies — the pane derives them
    the same way, so the two halves of the fixture stay honest. */
function peekProps(value: string, entry: Partial<CalEntry>, over: Record<string, unknown> = {}) {
  const note: NoteMeta = {
    path: PATH,
    stem: "Studio Week",
    title: "Studio Week",
    folder: "Events",
    props: { type: "event", [PROP]: value },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
  return {
    entry: {
      path: PATH,
      title: "Studio Week",
      type: "event",
      prop: PROP,
      day: "2026-08-10",
      ...entry,
    } as CalEntry,
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

/** an all-day run of three days, as the calendar expands it: no start time,
    a closing day, no closing hour anywhere */
const ALL_DAY_SPAN = {
  value: "2026-08-10/2026-08-12",
  entry: { day: "2026-08-10", endDay: "2026-08-12", spanPos: "start" as const },
};

async function render(
  t: Parameters<typeof renderComponent>[0],
  value: string,
  entry: Partial<CalEntry>,
  over: Record<string, unknown> = {},
) {
  const { default: CalPeek } = await import("../components/CalPeek.tsx");
  await renderComponent(t, h(CalPeek, peekProps(value, entry, over)));
}

test("an all-day multi-day span offers the Ends row", async (t) => {
  await render(t, ALL_DAY_SPAN.value, ALL_DAY_SPAN.entry);
  const field = one(".cal-peek-end");
  assert.ok(field, "the Ends row renders a field on an all-day span");
  assert.equal((field as HTMLInputElement).value, "", "no closing hour stored yet");
  // and the closing day sits beside it, so the empty field reads as
  // "ends the 12th, no hour" rather than as an hour on today
  assert.match(one(".cal-peek-endday")?.textContent ?? "", /12/);
});

test("typing an end hour on an all-day span writes it", async (t) => {
  const wrote: (string | null)[] = [];
  await render(t, ALL_DAY_SPAN.value, ALL_DAY_SPAN.entry, {
    onSetEnd: (time: string | null) => {
      wrote.push(time);
      return time;
    },
  });
  const field = one(".cal-peek-end");
  assert.ok(field);
  await type(field, "17:00");
  await pressEnter(field);
  assert.deepEqual(wrote, ["17:00"]);
  assert.equal((field as HTMLInputElement).value, "17:00");
});

test("a one-day all-day entry still has no Ends row", async (t) => {
  // nothing crosses days and there is no start hour: a closing hour here
  // would describe nothing, so the row stays away
  await render(t, "2026-08-10", { day: "2026-08-10" });
  assert.equal(one(".cal-peek-end"), null);
  assert.ok(one(".cal-peek-time"), "the Time row is still there");
});

test("the field shows the end that was STORED, not the one that was typed", async (t) => {
  // the pane clamps an end at or before the start rather than flipping the
  // pair, and hands back what it wrote — a row still reading the refused
  // value would be a plain lie
  const wrote: (string | null)[] = [];
  await render(
    t,
    "2026-08-10 09:00/2026-08-10 10:30",
    { day: "2026-08-10", time: "09:00", endDay: "2026-08-10", endTime: "10:30", spanPos: "start" },
    {
      onSetEnd: (time: string | null) => {
        wrote.push(time);
        return time === "07:00" ? "09:15" : time;
      },
    },
  );
  const field = one(".cal-peek-end");
  assert.ok(field);
  assert.equal((field as HTMLInputElement).value, "10:30");
  await type(field, "7:00");
  await pressEnter(field);
  assert.deepEqual(wrote, ["07:00"]);
  assert.equal((field as HTMLInputElement).value, "09:15");
});

test("the end's day is a button — a picked day reaches onSetEndDay bare", async (t) => {
  // the day-2 chip of a span dragged past midnight: the closing day beside
  // the Ends field opens a day picker, and picking the start day is the way
  // back to a single-day event — the pane clamps and keeps the hour
  const wrote: (string | null)[] = [];
  await render(
    t,
    "2026-08-10 20:00/2026-08-11 01:00",
    { day: "2026-08-11", endDay: "2026-08-11", endTime: "01:00", spanPos: "end" },
    { onSetEndDay: (iso: string | null) => wrote.push(iso) },
  );
  const btn = one(".cal-peek-endday");
  assert.ok(btn, "the closing day renders beside the Ends field");
  assert.equal(btn?.tagName, "BUTTON");
  await act(async () => (btn as HTMLButtonElement).click());
  const cell = one('.datemenu [data-iso="2026-08-10"]');
  assert.ok(cell, "the day picker opens on the end's own month");
  await act(async () => (cell as HTMLElement).click());
  assert.deepEqual(wrote, ["2026-08-10"]);
});

test("the picker's Clear drops the end whole", async (t) => {
  const wrote: (string | null)[] = [];
  await render(
    t,
    "2026-08-10 20:00/2026-08-11 01:00",
    { day: "2026-08-11", endDay: "2026-08-11", endTime: "01:00", spanPos: "end" },
    { onSetEndDay: (iso: string | null) => wrote.push(iso) },
  );
  await act(async () => (one(".cal-peek-endday") as HTMLButtonElement).click());
  const clear = Array.from(document.body.querySelectorAll(".datemenu .selmenu-btn")).find(
    (b) => b.textContent === "Clear",
  );
  assert.ok(clear, "the picker offers Clear");
  await act(async () => (clear as HTMLElement).click());
  assert.deepEqual(wrote, [null]);
});
