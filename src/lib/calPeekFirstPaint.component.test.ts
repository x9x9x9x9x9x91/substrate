/** The peek's Ends row at the FIRST paint after it mounts.

    A peek opened right after a resize write used to show an empty Ends field
    for a beat, filling in a moment later, while the Date row above it already
    read the whole value — which looked like the stored value arriving in two
    pieces. It was one piece all along: the Ends draft started empty and was
    filled by an effect, so the field was blank for exactly the one commit
    between render and effect, and a probe reading it in that window saw "".

    The draft is adjusted during render now, so there is no such window. This
    pins that: a layout effect reads the real DOM at the first commit, before
    any passive effect has run, and the closing hour is already in the field. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, useLayoutEffect } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { CalEntry } from "./calendar.ts";
import type { NoteMeta } from "./types.ts";

const PATH = "Events/Studio Week.md";
const PROP = "date";
/** the value a resize past midnight leaves behind: day one's start, day two's
    closing hour */
const STRANDED = "2026-08-26 09:00/2026-08-27 15:45";

const note: NoteMeta = {
  path: PATH,
  stem: "Studio Week",
  title: "Studio Week",
  folder: "Events",
  props: { type: "event", [PROP]: STRANDED },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

const peekProps = {
  entry: {
    path: PATH,
    title: "Studio Week",
    type: "event",
    prop: PROP,
    day: "2026-08-26",
    time: "09:00",
    endDay: "2026-08-27",
    spanPos: "start",
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
};

test("the Ends field carries the closing hour at the peek's first paint", async (t) => {
  const { default: CalPeek } = await import("../components/CalPeek.tsx");
  // what the DOM held at the first commit — a layout effect runs after the
  // browser would have the nodes and before any passive effect could fix them
  let atFirstPaint: string | undefined;
  const Probe = () => {
    useLayoutEffect(() => {
      atFirstPaint ??= (document.body.querySelector(".cal-peek-end") as HTMLInputElement | null)
        ?.value;
    });
    return null;
  };
  await renderComponent(t, h("div", null, h(CalPeek, peekProps), h(Probe, null)));

  assert.equal(atFirstPaint, "15:45", "no blank frame between mount and the value landing");
});
