/** The sheet grid's paint invalidation, pinned on the real component.

    A body that arrives from disk swaps under the open grid without a remount
    (`SheetGrid.tsx`, the docRef adoption effect). WKWebView has been reported
    presenting the composited layer the sticky header and totals row sandwich
    the rows into exactly as it was, so the grid reads blank until a hover
    repaints it. The fix carries `.sheet-scroll` through one frame of a
    geometrically identical transform. No headless engine reproduces the fault
    itself — what IS testable, and what would rot silently, is the mechanism:
    the class goes on when a body is adopted, and it comes back off, so the
    scrollport is not left permanently transformed. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const BODY_A = "```csv\nasset,units\nBTC,1\nETH,2\n```\n";
const BODY_B = "```csv\nasset,units\nBTC,9\nETH,8\n```\n";

const meta: NoteMeta = {
  path: "Sheet Repaint.md",
  stem: "Sheet Repaint",
  title: "Sheet Repaint",
  folder: "",
  props: { Type: "Sheet" },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

let win: MockWindow;

/* FRAMES ARE DRIVEN HERE, NOT WAITED ON. jsdom schedules rAF on a ~16ms timer,
   while the harness settles a render with zero-length macrotask turns — so on a
   loaded machine both frames fire before the first assertion and the class the
   mount just added has already come back off. Nothing can wait that back into
   existence, so the queue is owned instead: the component's frames run when
   this file says they do, and "on at mount, off after two frames" is a fact
   about the component rather than a race against the host. `invalidatePaint` is
   the only rAF caller in this tree — React 19 schedules on MessageChannel. */
const frameHost = globalThis as unknown as {
  requestAnimationFrame: (cb: () => void) => number;
};
const realRaf = frameHost.requestAnimationFrame;
let queued: Array<() => void> = [];

before(async () => {
  win = await mockBackend();
  frameHost.requestAnimationFrame = (cb) => queued.push(cb);
});
after(() => {
  frameHost.requestAnimationFrame = realRaf;
});

/** run one generation of frames — a frame queued BY a frame waits for the
    next generation, exactly as the browser would run it */
function frame() {
  const due = queued;
  queued = [];
  for (const cb of due) cb();
}

/** two frames: the class is dropped inside a rAF nested in a rAF */
function twoFrames() {
  frame();
  frame();
}

test("an adopted body nudges the scrollport, then leaves it alone", async (t) => {
  assert.ok(win, "mock backend installed");
  const { default: SheetGrid } = await import("../components/SheetGrid.tsx");
  const docRef: { current: ((body: string) => void) | null } = { current: null };
  const r = await renderComponent(
    t,
    h(SheetGrid, {
      meta,
      initial: BODY_A,
      vaultEpoch: 0,
      onChange: () => {},
      onFollowLink: () => {},
      docRef,
    })
  );

  const scroll = r.one(".sheet-scroll");
  assert.ok(scroll, "the grid rendered its scrollport");
  assert.equal(
    scroll.classList.contains("sheet-scroll-repaint"),
    true,
    "mount asks for the repaint before the frames run"
  );
  twoFrames();
  assert.equal(scroll.classList.contains("sheet-scroll-repaint"), false, "settled after mount");

  assert.ok(docRef.current, "the grid published its adoption hook");
  const swap = docRef.current;
  await (act as unknown as (cb: () => Promise<void>) => Promise<void>)(async () => {
    swap(BODY_B);
  });
  assert.equal(
    scroll.classList.contains("sheet-scroll-repaint"),
    true,
    "adoption asks for the repaint in the same turn as the swap"
  );

  await r.settle();
  twoFrames();
  assert.equal(
    scroll.classList.contains("sheet-scroll-repaint"),
    false,
    "the transform is one frame, not a permanent layer"
  );
  assert.match(r.text(), /9/, "and the adopted body is what rendered");
});
