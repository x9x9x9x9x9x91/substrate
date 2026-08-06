import { test } from "node:test";
import assert from "node:assert/strict";
import { placeTip, tipDelay, TIP_DELAY_MS, TIP_GAP, TIP_MARGIN } from "./tooltip.ts";

/* The tooltip primitive's geometry and dwell. The React host and the
   hover behaviour itself are covered in e2e/tooltip.spec.ts — these cover the
   parts that must hold without a DOM. */

const VIEW = { width: 1200, height: 800 };
const SIZE = { width: 160, height: 28 };

test("a tooltip sits below its trigger, centred (SUB-1161)", () => {
  const p = placeTip({ left: 500, top: 300, width: 24, height: 24 }, SIZE, VIEW);
  assert.equal(p.side, "bottom");
  assert.equal(p.top, 300 + 24 + TIP_GAP);
  assert.equal(p.left, 500 + 12 - 80, "centred on the trigger");
});

test("it flips above when below would overflow (SUB-1161)", () => {
  // a control near the window's bottom edge — the sidebar's footer row
  const p = placeTip({ left: 500, top: 770, width: 24, height: 24 }, SIZE, VIEW);
  assert.equal(p.side, "top");
  assert.equal(p.top, 770 - TIP_GAP - SIZE.height);
});

test("it stays below when neither side fits (SUB-1161)", () => {
  const tall = { width: 160, height: 700 };
  const p = placeTip({ left: 500, top: 400, width: 24, height: 24 }, tall, VIEW);
  assert.equal(p.side, "bottom", "no room either way — keep the default side");
  assert.ok(p.top >= TIP_MARGIN, "and still clamped onto the screen");
});

test("it clamps into the viewport at both edges (SUB-1161)", () => {
  const left = placeTip({ left: 2, top: 300, width: 20, height: 20 }, SIZE, VIEW);
  assert.equal(left.left, TIP_MARGIN, "a corner control still gets readable copy");

  const right = placeTip({ left: 1180, top: 300, width: 20, height: 20 }, SIZE, VIEW);
  assert.equal(right.left, VIEW.width - SIZE.width - TIP_MARGIN);
});

test("a bubble wider than the window clamps low, never negative (SUB-1161)", () => {
  const wide = { width: 1400, height: 28 };
  const p = placeTip({ left: 600, top: 300, width: 20, height: 20 }, wide, VIEW);
  assert.equal(p.left, TIP_MARGIN);
});

test("chrome along the bottom pushes the bubble off it, flipping early (SUB-1161)", () => {
  const rect = { left: 500, top: 700, width: 24, height: 24 };
  // no player: 700+24+6+28 = 758 <= 792, so below is genuinely fine
  assert.equal(placeTip(rect, SIZE, VIEW).side, "bottom");
  // with the 46px mini-player strip the visible floor is 746 — below would
  // put the copy under the player, so the bubble goes above instead
  const withPlayer = placeTip(rect, SIZE, VIEW, TIP_GAP, TIP_MARGIN, { top: 0, bottom: 46 });
  assert.equal(withPlayer.side, "top");
  assert.equal(withPlayer.top, 700 - TIP_GAP - SIZE.height);
});

test("a clamped bubble lands above the bottom chrome, not under it (SUB-1161)", () => {
  // a trigger with no room above either: the clamp, not the flip, is what
  // has to respect the inset
  const p = placeTip({ left: 500, top: 4, width: 790, height: 790 }, SIZE, VIEW, TIP_GAP, TIP_MARGIN, {
    top: 0,
    bottom: 46,
  });
  assert.equal(p.side, "bottom");
  assert.ok(
    p.top + SIZE.height <= VIEW.height - 46,
    `bubble bottom ${p.top + SIZE.height} must clear the player at ${VIEW.height - 46}`
  );
});

test("chrome along the top holds the flipped bubble below the banner (SUB-1161)", () => {
  // a tall bubble whose flip-above would land in the top 30px of the window:
  // fine against the raw viewport, under the time-travel banner in practice
  const tall = { width: 160, height: 500 };
  const rect = { left: 500, top: 536, width: 24, height: 24 };
  assert.equal(placeTip(rect, tall, VIEW).side, "top", "raw viewport says above has room");
  const p = placeTip(rect, tall, VIEW, TIP_GAP, TIP_MARGIN, { top: 64, bottom: 0 });
  assert.equal(p.side, "bottom", "above is banner, not room");

  // and a bubble that must clamp upward stops at the banner's edge
  const clamped = placeTip(
    { left: 500, top: 795, width: 24, height: 24 },
    { width: 160, height: 900 },
    VIEW,
    TIP_GAP,
    TIP_MARGIN,
    { top: 64, bottom: 46 }
  );
  assert.equal(clamped.top, TIP_MARGIN + 64, "taller than the band — anchored under the banner");
});

test("the inset is ignored when it is zero or negative (SUB-1161)", () => {
  const rect = { left: 500, top: 300, width: 24, height: 24 };
  const plain = placeTip(rect, SIZE, VIEW);
  const zero = placeTip(rect, SIZE, VIEW, TIP_GAP, TIP_MARGIN, { top: 0, bottom: 0 });
  const negative = placeTip(rect, SIZE, VIEW, TIP_GAP, TIP_MARGIN, { top: -20, bottom: -20 });
  assert.deepEqual(zero, plain);
  assert.deepEqual(negative, plain, "a negative inset never widens the band");
});

test("the first tooltip pays the dwell, a warm one opens instantly (SUB-1161)", () => {
  assert.equal(tipDelay(1000, 0), TIP_DELAY_MS, "cold");
  assert.equal(tipDelay(1000, 900), 0, "moving along a toolbar");
  assert.equal(tipDelay(5000, 900), TIP_DELAY_MS, "gone cold again");
});
