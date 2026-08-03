import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  clampDraggedSize,
  draggedSize,
  parseTerminalDock,
  parseTerminalSize,
  terminalSizeRange,
} from "./termdock.ts";

test("parseTerminalDock: only an explicit `right` docks anywhere else (SUB-864)", () => {
  assert.equal(parseTerminalDock("right"), "right");
  assert.equal(parseTerminalDock(" RIGHT "), "right");
  assert.equal(parseTerminalDock("Right"), "right");
  assert.equal(parseTerminalDock("bottom"), "bottom");
});

test("parseTerminalDock: unset, garbage or non-string all read as bottom", () => {
  // bottom is the shape the HUD has always had (SUB-398), so it's the one a
  // typo'd or synced-from-a-newer-version note should fall back to
  for (const bad of [undefined, null, "", "  ", "left", "top", "botom", 7, true, ["right"], {}]) {
    assert.equal(parseTerminalDock(bad), "bottom", `dock ${JSON.stringify(bad)}`);
  }
});

test("terminalSizeRange: height and width have separate ranges (SUB-864)", () => {
  assert.deepEqual(terminalSizeRange("bottom"), {
    min: 0.2,
    max: 0.9,
    fallback: DEFAULT_TERMINAL_HEIGHT,
  });
  assert.deepEqual(terminalSizeRange("right"), {
    min: 0.2,
    max: 0.7,
    fallback: DEFAULT_TERMINAL_WIDTH,
  });
});

test("parseTerminalSize: in-range values pass through, strings and numbers alike", () => {
  // frontmatter `terminal-width: 0.5` may arrive as a number, not a string
  assert.equal(parseTerminalSize("bottom", "0.6"), 0.6);
  assert.equal(parseTerminalSize("bottom", 0.6), 0.6);
  assert.equal(parseTerminalSize("right", "0.5"), 0.5);
  assert.equal(parseTerminalSize("right", 0.5), 0.5);
  // the bounds themselves are allowed
  assert.equal(parseTerminalSize("bottom", 0.2), 0.2);
  assert.equal(parseTerminalSize("bottom", 0.9), 0.9);
  assert.equal(parseTerminalSize("right", 0.7), 0.7);
});

test("parseTerminalSize: de-DE typed fractions read as their value (SUB-926)", () => {
  assert.equal(parseTerminalSize("bottom", "0,6"), 0.6);
  assert.equal(parseTerminalSize("right", "0,5"), 0.5);
  // canonical spelling unaffected, garbage still falls back
  assert.equal(parseTerminalSize("bottom", "0.6"), 0.6);
  assert.equal(parseTerminalSize("bottom", ",6"), DEFAULT_TERMINAL_HEIGHT);
});

test("parseTerminalSize: a typed out-of-range value falls back, it does NOT clamp", () => {
  // `terminal-height: 7` is a mistake, not a request for 90% — landing on the
  // default says "this key isn't doing anything" more clearly than 0.9 would
  assert.equal(parseTerminalSize("bottom", 7), DEFAULT_TERMINAL_HEIGHT);
  assert.equal(parseTerminalSize("bottom", 0.05), DEFAULT_TERMINAL_HEIGHT);
  assert.equal(parseTerminalSize("right", 0.9), DEFAULT_TERMINAL_WIDTH);
  for (const bad of [undefined, null, "", "tall", true, [0.5], {}, NaN, Infinity]) {
    assert.equal(parseTerminalSize("right", bad), DEFAULT_TERMINAL_WIDTH, JSON.stringify(bad));
  }
});

test("clampDraggedSize: a drag DOES clamp, and rounds to whole percent", () => {
  // the opposite rule from typing: the pointer runs past the range constantly
  // and the panel should stop at the edge, not snap back to the default
  assert.equal(clampDraggedSize("bottom", 1.4), 0.9);
  assert.equal(clampDraggedSize("bottom", -0.3), 0.2);
  assert.equal(clampDraggedSize("right", 0.95), 0.7);
  assert.equal(clampDraggedSize("right", 0.01), 0.2);
  // rounded to the granularity the panel renders at (`Nvh` / `Nvw`)
  assert.equal(clampDraggedSize("bottom", 0.5551), 0.56);
  assert.equal(clampDraggedSize("right", 0.33333), 0.33);
  // a non-number can't be clamped into anything meaningful
  assert.equal(clampDraggedSize("bottom", NaN), DEFAULT_TERMINAL_HEIGHT);
});

test("draggedSize: travel away from the anchored edge grows the panel (SUB-863)", () => {
  // docked bottom in a 1000px-tall window: dragging the top edge up 100px
  // (grow = +100) takes it from 45% to 55%
  assert.equal(draggedSize("bottom", 0.45, 100, 1000), 0.55);
  // and back down again
  assert.equal(draggedSize("bottom", 0.45, -100, 1000), 0.35);
  // docked right in a 1000px-wide window: dragging the left edge left grows it
  assert.equal(draggedSize("right", 0.4, 100, 1000), 0.5);
  assert.equal(draggedSize("right", 0.4, -100, 1000), 0.3);
});

test("draggedSize: a drag past the range stops at the bound", () => {
  assert.equal(draggedSize("bottom", 0.85, 400, 1000), 0.9);
  assert.equal(draggedSize("bottom", 0.25, -400, 1000), 0.2);
  assert.equal(draggedSize("right", 0.65, 400, 1000), 0.7);
});

test("draggedSize: a zero-size window can't be divided into", () => {
  // guards the degenerate first-frame case rather than yielding Infinity
  assert.equal(draggedSize("bottom", 0.45, 100, 0), 0.45);
  assert.equal(draggedSize("right", 0.4, 100, -1), 0.4);
});

test("draggedSize: no travel is no change (SUB-863)", () => {
  // the mouseup path leans on this to skip committing a plain click
  assert.equal(draggedSize("bottom", 0.45, 0, 1000), 0.45);
  assert.equal(draggedSize("right", 0.38, 0, 1000), 0.38);
});
