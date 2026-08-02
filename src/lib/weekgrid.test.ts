import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DAY_MIN,
  DEFAULT_DURATION_MIN,
  MIN_BLOCK_MIN,
  blockSpan,
  layoutLanes,
  minutesToTime,
  snapMinutes,
  timeToMinutes,
} from "./weekgrid.ts";

test("timeToMinutes parses HH:MM and rejects junk", () => {
  assert.equal(timeToMinutes("00:00"), 0);
  assert.equal(timeToMinutes("14:30"), 870);
  assert.equal(timeToMinutes("23:59"), 1439);
  assert.equal(timeToMinutes("24:00"), null);
  assert.equal(timeToMinutes("12:60"), null);
  assert.equal(timeToMinutes("9:30"), null); // two-digit contract — inputs are splitDayTime's padded output
  assert.equal(timeToMinutes(""), null);
});

test("minutesToTime formats and clamps into the day", () => {
  assert.equal(minutesToTime(0), "00:00");
  assert.equal(minutesToTime(870), "14:30");
  assert.equal(minutesToTime(-20), "00:00");
  assert.equal(minutesToTime(DAY_MIN + 100), "23:59");
});

test("snapMinutes lands on quarter hours, clamped inside the day", () => {
  assert.equal(snapMinutes(0), 0);
  assert.equal(snapMinutes(7), 0);
  assert.equal(snapMinutes(8), 15);
  assert.equal(snapMinutes(871), 870);
  assert.equal(snapMinutes(-30), 0);
  assert.equal(snapMinutes(DAY_MIN), DAY_MIN - 15);
});

test("layoutLanes: disjoint entries stay full width", () => {
  const boxes = layoutLanes([
    { start: 60, end: 120 },
    { start: 180, end: 240 },
  ]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [0, 1],
      [0, 1],
    ]
  );
});

test("layoutLanes: two overlapping entries split into two lanes", () => {
  const boxes = layoutLanes([
    { start: 60, end: 180 },
    { start: 120, end: 240 },
  ]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [0, 2],
      [1, 2],
    ]
  );
});

test("layoutLanes: a lane frees up once its entry ends", () => {
  // A 09–10, B 09:30–10:30, C 10–11 — C reuses A's lane; the cluster is 2 wide
  const boxes = layoutLanes([
    { start: 540, end: 600 },
    { start: 570, end: 630 },
    { start: 600, end: 660 },
  ]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [0, 2],
      [1, 2],
      [0, 2],
    ]
  );
});

test("layoutLanes: disjoint clusters reset the lane count", () => {
  // morning pair overlaps (2 lanes); the evening single is full width again
  const boxes = layoutLanes([
    { start: 540, end: 600 },
    { start: 540, end: 600 },
    { start: 1080, end: 1140 },
  ]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ]
  );
});

test("layoutLanes: three-way overlap widens the whole cluster", () => {
  const boxes = layoutLanes([
    { start: 60, end: 300 },
    { start: 120, end: 240 },
    { start: 180, end: 360 },
  ]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [0, 3],
      [1, 3],
      [2, 3],
    ]
  );
});

test("layoutLanes: output order mirrors input order", () => {
  const boxes = layoutLanes([
    { start: 120, end: 240 },
    { start: 60, end: 180 },
  ]);
  // input[0] starts later → it gets the second lane, but stays at index 0
  assert.deepEqual(
    boxes.map((b) => [b.start, b.lane, b.lanes]),
    [
      [120, 1, 2],
      [60, 0, 2],
    ]
  );
});

test("layoutLanes: a long container over nested shorts stays wide (greedy, pinned)", () => {
  // one 3h block spanning two sequential 1h blocks: greedy packing keeps
  // the whole cluster 2 wide — correct, if not optimal; a future packing
  // change should trip this deliberately. (start, end) order places the
  // shorter same-start block first, so the container lands in lane 1.
  const boxes = layoutLanes([
    { start: 60, end: 240 },
    { start: 60, end: 120 },
    { start: 120, end: 180 },
  ]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [1, 2],
      [0, 2],
      [0, 2],
    ]
  );
});

test("layoutLanes: empty input", () => {
  assert.deepEqual(layoutLanes([]), []);
});

test("blockSpan: a same-day end time sets the block's height (SUB-646)", () => {
  assert.deepEqual(blockSpan("09:00", "17:00"), { start: 540, end: 1020 });
  assert.deepEqual(blockSpan("14:00", "14:45"), { start: 840, end: 885 });
});

test("blockSpan: no end time falls back to the default hour", () => {
  assert.deepEqual(blockSpan("14:00"), { start: 840, end: 840 + DEFAULT_DURATION_MIN });
  assert.deepEqual(blockSpan("14:00", ""), { start: 840, end: 840 + DEFAULT_DURATION_MIN });
});

test("blockSpan: an unusable end time falls back rather than painting a sliver", () => {
  // junk, equal to the start, or earlier than it — all default to an hour
  assert.deepEqual(blockSpan("09:00", "nope"), { start: 540, end: 600 });
  assert.deepEqual(blockSpan("09:00", "09:00"), { start: 540, end: 600 });
  assert.deepEqual(blockSpan("09:00", "08:00"), { start: 540, end: 600 });
});

test("blockSpan: short events keep a minimum visible height", () => {
  const { start, end } = blockSpan("09:00", "09:10");
  assert.equal(end - start, MIN_BLOCK_MIN);
});

test("blockSpan: the end clamps into the day", () => {
  assert.deepEqual(blockSpan("23:30", "23:59"), { start: 1410, end: DAY_MIN });
  // the default hour would overflow midnight too
  assert.deepEqual(blockSpan("23:30"), { start: 1410, end: DAY_MIN });
});

test("blockSpan feeds layoutLanes: an entry inside a long range shares lanes (SUB-646)", () => {
  // 09:00–17:00 next to a plain 14:00 — truncating the range to one hour
  // used to leave the 14:00 entry full-width as if the afternoon were free
  const boxes = layoutLanes([blockSpan("09:00", "17:00"), blockSpan("14:00")]);
  assert.deepEqual(
    boxes.map((b) => [b.lane, b.lanes]),
    [
      [0, 2],
      [1, 2],
    ]
  );
});
