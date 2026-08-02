import { test } from "node:test";
import assert from "node:assert/strict";

import { claimDrop, dropClaimedNear, dropClientPoint, dropHintText } from "./dragdrop.ts";

test("dropClientPoint keeps macOS points unscaled on Retina (SUB-414)", () => {
  // AppKit reports logical points; dividing by dpr 2 was halving every
  // coordinate and made elementFromPoint miss the editor entirely
  assert.deepEqual(dropClientPoint({ x: 800, y: 600 }, 2, "MacIntel"), { x: 800, y: 600 });
  assert.deepEqual(dropClientPoint({ x: 800, y: 600 }, 1, "MacIntel"), { x: 800, y: 600 });
});

test("dropClientPoint divides by dpr on Windows (physical pixels)", () => {
  assert.deepEqual(dropClientPoint({ x: 800, y: 600 }, 2, "Win32"), { x: 400, y: 300 });
  // a zero/undefined ratio must not divide by zero
  assert.deepEqual(dropClientPoint({ x: 800, y: 600 }, 0, "Win32"), { x: 800, y: 600 });
});

test("dropClientPoint keeps GTK logical coordinates unscaled", () => {
  assert.deepEqual(dropClientPoint({ x: 10, y: 20 }, 2, "Linux x86_64"), { x: 10, y: 20 });
});

test("drop claims register within slack, expire outside it", () => {
  claimDrop(1000);
  assert.ok(dropClaimedNear(1005), "claim just before the check counts");
  assert.ok(dropClaimedNear(990), "claim just after the check counts (listener order unknown)");
  assert.ok(!dropClaimedNear(2000), "a stale claim does not suppress the next drop's toast");
});

test("dropHintText teaches the shift-link affordance both ways (SUB-438)", () => {
  const plain = dropHintText(false);
  const shifted = dropHintText(true);
  assert.notEqual(plain, shifted, "wording flips when shift goes down");
  assert.match(plain, /⇧/, "the plain state names the modifier to discover");
  assert.match(shifted, /link/i);
});
