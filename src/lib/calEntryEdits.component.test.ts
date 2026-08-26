/** Two entry edits driven through the pane against the mock vault (the
 *  harness pattern is written up in `docs/component-tests.md`). Both bugs
 *  they pin live BETWEEN the field and the value on disk, where neither a
 *  unit test on the pure helper nor a type check can see them: the peek's
 *  Time row used to hand the pane a value that came home with a START the
 *  user never typed, and the Repeat row used to write a new cadence on top
 *  of a finished series' end date, so the pick appeared to do nothing.
 *
 *  Every assertion reads the note's stored props back out of the vault —
 *  the stored value is what a reload would show. The week grid is the
 *  surface here because the seeded vault crowds the month cells, and an
 *  entry hidden behind “+N more” cannot be clicked. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h, useEffect, useState } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

let win: MockWindow;
let CalendarPane: typeof import("../components/CalendarPane.tsx").default;

const PATH = "Entry Edit Fixture.md";
const TITLE = "Entry Edit Fixture";

/** the peek and the repeat picker portal to the body */
const one = (sel: string) => document.body.querySelector(sel);
const all = (sel: string) => [...document.body.querySelectorAll(sel)];

before(async () => {
  win = await mockBackend();
  CalendarPane = (await import("../components/CalendarPane.tsx")).default;
  win.__mockCloneNote("Weight Log.md", PATH);
  win.__mockEditProp(PATH, "type", "event");
});

/** days of the week the pane opens on, counted from its Monday, so no
    fixture falls off the grid whichever weekday the suite runs on */
const weekDay = (offset: number): string => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const storedProp = async (key: string): Promise<unknown> => {
  const { vaultList } = await import("./ipc.ts");
  const notes = await vaultList();
  return notes.find((n: NoteMeta) => n.path === PATH)?.props[key];
};

/** the pane with the vault behind it: `onMutated` re-lists, so an edit's
    write comes back as new notes exactly as it does in the app */
const LiveCalendar = () => {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const reload = () => {
    import("./ipc.ts").then(({ vaultList }) => vaultList().then(setNotes));
  };
  useEffect(reload, []);
  return h(CalendarPane, {
    notes,
    schema: {} as SchemaConfig,
    newSignal: 0,
    onOpenNote: () => {},
    onMutated: reload,
    onTrashNote: () => {},
    onRenameNote: async () => {},
    onOpenJournal: () => {},
  });
};

interface Grid {
  one(s: string): Element | null;
  all(s: string): Element[];
  click(el: Element): Promise<void>;
  settle(): Promise<void>;
}

/** render the week grid over the fixture and open its peek — clicking the
    block is what selects an event and opens it */
const peekOnFixture = async (t: Parameters<typeof renderComponent>[0]): Promise<Grid> => {
  win.localStorage.setItem("substrate.calLayout", "week");
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();
  const block = r.all(".cal-wk-block").find((b) => b.textContent?.includes(TITLE));
  assert.ok(block, "the fixture should render as a timed block on the week grid");
  await r.click(block);
  assert.ok(one(".cal-peek"), "clicking the block opens its peek");
  return r;
};

/** type into a field and commit it the way a person does — the harness
    synthesizes clicks only, so the value goes in through the native setter
    React's onChange listens behind */
const typeAndEnter = async (field: Element, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
};

test("a start time typed past the block's own end moves the END, not the start", async (t) => {
  win.__mockEditProp(PATH, "repeat", null);
  win.__mockEditProp(PATH, "date", `${weekDay(2)} 09:00/${weekDay(2)} 10:30`);
  const r = await peekOnFixture(t);

  const field = one(".cal-peek-time");
  assert.ok(field, "the peek carries a Time row");
  await typeAndEnter(field, "18:00");
  await r.settle();

  assert.equal(
    await storedProp("date"),
    `${weekDay(2)} 18:00/${weekDay(2)} 19:30`,
    "the typed time stays the START and the block keeps its length"
  );
  // and the row must not sit there showing a start the write refused
  assert.equal((one(".cal-peek-time") as HTMLInputElement | null)?.value, "18:00");
  // the Ends row beside it reads the moved end, not the one it overtook
  assert.equal((one(".cal-peek-end") as HTMLInputElement | null)?.value, "19:30");
});

test("picking a cadence clears the boundary an ended series left behind", async (t) => {
  win.__mockEditProp(PATH, "date", `${weekDay(0)} 09:00/${weekDay(0)} 10:00`);
  win.__mockEditProp(PATH, "repeat", "daily");
  // what "Delete this and following" leaves on the note: an end boundary,
  // plus a day skipped against the cadence about to be replaced
  win.__mockEditProp(PATH, "repeat_until", weekDay(1));
  win.__mockEditProp(PATH, "repeat_skip", [weekDay(1)]);
  const r = await peekOnFixture(t);

  const row = all(".cal-peek-row").find((b) => b.textContent?.includes("Repeat"));
  assert.ok(row, "the peek carries a Repeat row");
  await r.click(row);
  const weekly = all(".selmenu-item").find((i) => i.textContent?.startsWith("Weekly"));
  assert.ok(weekly, "the repeat picker offers Weekly");
  await r.click(weekly);
  await r.settle();

  assert.equal(await storedProp("repeat"), "weekly", "the new cadence is written");
  assert.equal(await storedProp("repeat_until"), undefined, "the old boundary is gone");
  assert.equal(await storedProp("repeat_skip"), undefined, "so are the old skips");
  // and the re-cadenced series still shows on the grid it was picked from
  assert.ok(
    r.all(".cal-wk-block").some((b) => b.textContent?.includes(TITLE)),
    "the series renders under its new cadence"
  );
});
