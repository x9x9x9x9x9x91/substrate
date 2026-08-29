/** The calendar's multi-day spans, as the grid hands them back after a drag.
 *
 *  Two things used to strand an event the moment it became a span: its
 *  continuation days rendered as inert chips, and the drag state the pane
 *  keeps never came back to rest, because a move re-keys the chip to its new
 *  column and the unmounted node fires no `dragend` of its own. Both are
 *  invisible to tsc — the first is one boolean on an attribute, the second an
 *  effect that only shows in what a later render puts in the class list.
 *
 *  Those two pin the pieces in isolation. The tests further down drive the
 *  gesture that actually broke — drag an event until it BECOMES a span, then
 *  drag it again — against the mock vault, re-reading the notes after every
 *  write the way the app does, so the second grab lands on chips the first
 *  drag wrote. They also hold the drop's meaning: a slide keeps the range's
 *  times on the timed canvas and shows no minute it would throw away, and the
 *  all-day strip clears the start's time whichever day of the range was
 *  grabbed. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h, useEffect, useState } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

let win: MockWindow;
/** CalendarPane, pulled in once the harness has installed the DOM globals —
    module scope here is AFTER that import, but the component still has to
    come in dynamically, and the live wrapper below needs it by name */
let CalendarPane: typeof import("../components/CalendarPane.tsx").default;

/** which grid the pane opens on. It reads the layout once, at mount, off the
    key the switcher persists — so every test that cares names its grid rather
    than inheriting whatever the test before it left behind. */
const openGrid = (l: "month" | "week") =>
  win.localStorage.setItem("substrate.calLayout", l);

before(async () => {
  win = await mockBackend();
  CalendarPane = (await import("../components/CalendarPane.tsx")).default;
  win.__mockCloneNote("Weight Log.md", SPAN_PATH);
  win.__mockEditProp(SPAN_PATH, "type", "event");
});

/** yesterday and today, ISO. A span that starts yesterday puts its TAIL on
    today whatever the month boundary does — the grid pads both ends. */
const dayOf = (offset: number): string => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const SPAN_NOTE: NoteMeta = {
  path: "Span Fixture.md",
  stem: "Span Fixture",
  title: "Span Fixture",
  folder: "",
  props: { type: "event", date: `${dayOf(-1)} 09:00/${dayOf(0)} 17:00` },
  updated_ms: Date.now(),
  excerpt: "",
  sealed: false,
};

const props = {
  notes: [SPAN_NOTE],
  schema: {} as SchemaConfig,
  newSignal: 0,
  onOpenNote: () => {},
  onMutated: () => {},
  onTrashNote: () => {},
  onRenameNote: async () => {},
  onOpenJournal: () => {},
  upcomingDock: "bottom" as const,
};

/** the fixture's chip on a given day of the month grid */
const chipOn = (r: { one(s: string): Element | null }, iso: string) =>
  r.one(`.cal-day[data-iso="${iso}"] .cal-entry`);

test("a span's continuation day is a drag source, not an inert chip", async (t) => {
  openGrid("month");
  const r = await renderComponent(t, h(CalendarPane, props));
  const tail = chipOn(r, dayOf(0));
  assert.ok(tail, "the span's second day should render a chip on today's cell");
  assert.equal(tail.getAttribute("draggable"), "true");
});

test("the grid comes back to rest on a dragend the source never sees", async (t) => {
  openGrid("month");
  const r = await renderComponent(t, h(CalendarPane, props));
  const head = chipOn(r, dayOf(-1));
  assert.ok(head, "the span's first day should render a chip");

  // jsdom has no drag-and-drop: the payload the handler writes is stubbed on
  // to a plain event, which is all React needs to route it
  const start = new win.Event("dragstart", { bubbles: true });
  Object.defineProperty(start, "dataTransfer", {
    value: { setData: () => {}, effectAllowed: "" },
  });
  await act(async () => {
    head.dispatchEvent(start);
  });
  await r.settle();
  assert.ok(
    chipOn(r, dayOf(-1))?.classList.contains("dragging"),
    "the grabbed span should be marked as in flight"
  );

  // the source is still mounted here, but the window listener is what a real
  // move relies on — so the event goes to the window, not to the chip
  await act(async () => {
    win.dispatchEvent(new win.Event("dragend", { bubbles: true }));
  });
  await r.settle();
  assert.equal(chipOn(r, dayOf(-1))?.classList.contains("dragging"), false);
});

/* ---- the whole gesture, end to end, against the real write path ----

   The two tests above pin the pieces; these drive the sequence that broke:
   drag an event so that it BECOMES a span, then drag it again. That second
   grab lands on a chip the first drag created, in a column the first drag
   re-keyed — which is exactly the ground the old bug stood on, and neither an
   attribute nor a synthetic `dragend` reaches it. The notes prop is re-read
   from the mock vault on every write, the way the app re-reads it, so the
   grid under the second gesture is the grid the first one produced. */

/** the week the pane opens on runs Monday–Sunday around today; every day this
    file drags to is named from that Monday, so no offset can fall off the
    grid whichever weekday the suite happens to run on. */
const weekDay = (offset: number): string => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const SPAN_PATH = "Drag Span Fixture.md";
const SPAN_TITLE = "Drag Span Fixture";

/** jsdom has no drag-and-drop at all: the payload the handlers write is
    stubbed on to a plain event, which is all React needs to route it. A drop
    on the timed canvas also carries the pointer's y — the minute it lands on
    is read off the column's box. */
const dragEvent = (type: string, clientY?: number) => {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      setData: () => {},
      getData: () => "",
      effectAllowed: "",
      dropEffect: "",
    },
  });
  if (clientY !== undefined)
    Object.defineProperty(ev, "clientY", { value: clientY });
  return ev;
};

/** jsdom lays nothing out, so every box is zero and the canvas's minute math
    would divide by it. One minute per pixel from the top of the column makes
    the drops below read as the times they name. */
const asDayTall = (el: Element): Element => {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: 0,
      height: 1440,
      left: 0,
      width: 100,
      bottom: 1440,
      right: 100,
    }),
  });
  return el;
};

/** the fixture's date prop as the vault now holds it — the assertion target,
    because the value is what a reload would show */
const storedDate = async (): Promise<string | undefined> => {
  const { vaultList } = await import("./ipc.ts");
  const notes = await vaultList();
  return notes.find((n: NoteMeta) => n.path === SPAN_PATH)?.props.date as
    | string
    | undefined;
};

/** the pane with the vault behind it: `onMutated` re-lists, so a drag's write
    comes back as new notes and the chips re-render where the value now puts
    them — no hand-fed prop standing in for the round trip */
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
    upcomingDock: "bottom" as const,
  });
};

/** stage the fixture as a plain 09:00–10:00 event on the week's Monday and
    open the week grid on it */
const stageTimedEvent = async () => {
  openGrid("week");
  win.__mockEditProp(SPAN_PATH, "date", `${weekDay(0)} 09:00/${weekDay(0)} 10:00`);
};

interface Grid {
  one(s: string): Element | null;
  all(s: string): Element[];
  settle(): Promise<void>;
}

/** the fixture's own chip among a day's — the seeded vault has entries of its
    own on these days, so nothing here may take "the first one" */
const fixtureIn = (r: Grid, selector: string) =>
  r.all(selector).find((el) => el.textContent?.includes(SPAN_TITLE));

const canvasCol = (r: Grid, iso: string) =>
  asDayTall(r.one(`.cal-wk-col[data-iso="${iso}"]`)!);

const stripCell = (r: Grid, iso: string) =>
  r.one(`.cal-wk-cell[data-iso="${iso}"]`)!;

/** grow the fixture into a two-day span by dragging its bottom-edge grip on
    to the next day's canvas, and hand back the tail chip that appears */
const growIntoSpan = async (r: Grid) => {
  const block = fixtureIn(r, `.cal-wk-col[data-iso="${weekDay(0)}"] .cal-wk-block`);
  assert.ok(block, "the fixture should render as a timed block on the week's first day");
  const grip = block.querySelector(".cal-wk-grip:not(.top)");
  assert.ok(grip, "a timed block carries the duration grip");
  await act(async () => {
    grip.dispatchEvent(dragEvent("dragstart"));
  });
  await r.settle();
  await act(async () => {
    canvasCol(r, weekDay(1)).dispatchEvent(dragEvent("drop", 840));
  });
  await r.settle();
  assert.equal(
    await storedDate(),
    `${weekDay(0)} 09:00/${weekDay(1)} 14:00`,
    "the grip drag should have carried the end on to the next day"
  );
  const tail = fixtureIn(r, `.cal-wk-cell[data-iso="${weekDay(1)}"] .cal-entry`);
  assert.ok(tail, "the span's second day should render a chip of its own");
  return tail;
};

test("an event dragged into a span can be dragged again, and slides whole", async (t) => {
  await stageTimedEvent();
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();

  const tail = await growIntoSpan(r);
  assert.equal(
    r.all(".dragging").length,
    0,
    "the grid must come to rest after the drag that made the span"
  );
  assert.equal(tail.getAttribute("draggable"), "true");

  // the second gesture: the tail travels three days, so the whole range does
  await act(async () => {
    tail.dispatchEvent(dragEvent("dragstart"));
  });
  await r.settle();
  await act(async () => {
    canvasCol(r, weekDay(4)).dispatchEvent(dragEvent("drop", 600));
  });
  await r.settle();
  assert.equal(
    await storedDate(),
    `${weekDay(3)} 09:00/${weekDay(4)} 14:00`,
    "grabbing day two and dropping three days on should slide the range by three days, times intact"
  );
  assert.equal(r.all(".dragging").length, 0, "and the grid comes to rest again");
});

/** the value an all-day drop leaves behind, for a span grown from the fixture
    and released on the strip cell of `weekDay(3)`. Both ends travel; the
    START's time goes, because that is what the strip cell says about the
    entry it takes. The END keeps its clock — a drop names a day, and nothing
    about the strip claims to retime the far end of a range. */
const allDayResult = `${weekDay(2)}/${weekDay(3)} 14:00`;

test("a tail dropped on the all-day strip clears the time, as its head does", async (t) => {
  await stageTimedEvent();
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();

  const tail = await growIntoSpan(r);
  await act(async () => {
    tail.dispatchEvent(dragEvent("dragstart"));
  });
  await r.settle();
  await act(async () => {
    stripCell(r, weekDay(3)).dispatchEvent(dragEvent("drop"));
  });
  await r.settle();
  assert.equal(
    await storedDate(),
    allDayResult,
    "the strip says all-day whichever day of the range was grabbed"
  );
});

test("the head's own strip drop lands on the same value", async (t) => {
  await stageTimedEvent();
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();

  // the pair is the point: head and tail differ only in which day the hand
  // took hold of, so they may not differ in what the drop means
  await growIntoSpan(r);
  const head = fixtureIn(r, `.cal-wk-col[data-iso="${weekDay(0)}"] .cal-wk-block`);
  assert.ok(head, "the span's first day keeps its timed block");
  await act(async () => {
    head.dispatchEvent(dragEvent("dragstart"));
  });
  await r.settle();
  await act(async () => {
    stripCell(r, weekDay(2)).dispatchEvent(dragEvent("drop"));
  });
  await r.settle();
  assert.equal(await storedDate(), allDayResult);
});

test("a whole-day slide shows no minute the drop would throw away", async (t) => {
  await stageTimedEvent();
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();

  const tail = await growIntoSpan(r);
  const over = (iso: string) =>
    act(async () => {
      canvasCol(r, iso).dispatchEvent(dragEvent("dragover", 600));
    });

  // the head names its own minute — the ghost is honest there
  const head = fixtureIn(r, `.cal-wk-col[data-iso="${weekDay(0)}"] .cal-wk-block`);
  assert.ok(head);
  await act(async () => {
    head.dispatchEvent(dragEvent("dragstart"));
  });
  await over(weekDay(4));
  await r.settle();
  assert.ok(r.one(".cal-wk-ghost"), "a move drag paints the minute it will land on");
  await act(async () => {
    win.dispatchEvent(new win.Event("dragend", { bubbles: true }));
  });
  await r.settle();

  // the tail's drop keeps the range's times, so labelling a minute would be a
  // promise the write doesn't keep — the column still lights up as a target
  await act(async () => {
    tail.dispatchEvent(dragEvent("dragstart"));
  });
  await over(weekDay(4));
  await r.settle();
  assert.equal(r.one(".cal-wk-ghost"), null, "a whole-day slide shows no time ghost");
  assert.ok(
    r.one(`.cal-wk-col[data-iso="${weekDay(4)}"]`)?.classList.contains("drop"),
    "but the column it would land on still reads as the drop target"
  );
});

test("the end-day picker on an ALL-DAY span picked home drops the end whole", async (t) => {
  // the D/D value the write would otherwise produce keeps an invisible end:
  // the chip looks single-day, but the peek's Ends row is gone and the Date
  // row reads "Aug 10–10". Picking the start's own day means "one day", so
  // the end goes with it.
  openGrid("week");
  win.__mockEditProp(SPAN_PATH, "date", `${weekDay(0)}/${weekDay(1)}`);
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();
  const tail = fixtureIn(r, `.cal-wk-cell[data-iso="${weekDay(1)}"] .cal-entry`);
  assert.ok(tail, "the all-day span's second day should render a chip");
  await act(async () => {
    (tail as HTMLElement).click();
  });
  await r.settle();
  const endday = document.body.querySelector(".cal-peek-endday");
  assert.ok(endday, "the peek should wear the closing day as a button");
  await act(async () => {
    (endday as HTMLElement).click();
  });
  await r.settle();
  const cell = document.body.querySelector(`.datemenu [data-iso="${weekDay(0)}"]`);
  assert.ok(cell, "the end-day picker should offer the start's own day");
  await act(async () => {
    (cell as HTMLElement).click();
  });
  await r.settle();
  assert.equal(
    await storedDate(),
    weekDay(0),
    "picking the start's own day on an all-day span drops the end whole"
  );
});

test("the end-day picker on a TIMED start with a day-only end picks home clean", async (t) => {
  // the shape behind an emptied Ends hour: `09:00/nextday` with no closing
  // clock. Routing the pick through the clamp would GROW the event a day
  // (the clamp's degeneracy guard) and then go inert — home means the end
  // drops and the plain timed event remains.
  openGrid("week");
  win.__mockEditProp(SPAN_PATH, "date", `${weekDay(0)} 09:00/${weekDay(1)}`);
  const r = await renderComponent(t, h(LiveCalendar, {}));
  await r.settle();
  const tail = fixtureIn(r, `.cal-wk-cell[data-iso="${weekDay(1)}"] .cal-entry`);
  assert.ok(tail, "the day-only end should render day two as an all-day chip");
  await act(async () => {
    (tail as HTMLElement).click();
  });
  await r.settle();
  const endday = document.body.querySelector(".cal-peek-endday");
  assert.ok(endday, "the peek should wear the closing day as a button");
  await act(async () => {
    (endday as HTMLElement).click();
  });
  await r.settle();
  const cell = document.body.querySelector(`.datemenu [data-iso="${weekDay(0)}"]`);
  assert.ok(cell, "the end-day picker should offer the start's own day");
  await act(async () => {
    (cell as HTMLElement).click();
  });
  await r.settle();
  assert.equal(
    await storedDate(),
    `${weekDay(0)} 09:00`,
    "picking home on a timed start drops the day-only end, keeping the clock"
  );
});
