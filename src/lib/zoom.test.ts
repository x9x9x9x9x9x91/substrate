import { test } from "node:test";
import assert from "node:assert/strict";
import { parseZoom, stepZoom, zoomLabel, ZOOM_LEVELS } from "./zoom.ts";

test("stepZoom walks the ladder and clamps at both ends", () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1.1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1), 2);
  assert.equal(stepZoom(ZOOM_LEVELS[0], -1), 0.7);
});

test("an off-ladder level snaps to the nearest rung before stepping", () => {
  // 1.06 sits nearest 1.1 → stepping down lands one rung under it
  assert.equal(stepZoom(1.06, -1), 1);
  assert.equal(stepZoom(1.06, 1), 1.25);
});

test("parseZoom accepts stored levels and rejects garbage", () => {
  assert.equal(parseZoom("1.25"), 1.25);
  assert.equal(parseZoom(null), 1);
  assert.equal(parseZoom("banana"), 1);
  assert.equal(parseZoom("0.1"), 1);
  assert.equal(parseZoom("9"), 1);
});

test("zoomLabel renders whole percentages", () => {
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(1.25), "125%");
  assert.equal(zoomLabel(0.9), "90%");
});
