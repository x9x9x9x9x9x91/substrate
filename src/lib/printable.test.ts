import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  getPrintable,
  registerPrintable,
  resetPrintableForTests,
  subscribePrintable,
} from "./printable.ts";

beforeEach(() => resetPrintableForTests());

test("nothing prints until a pane says it can", () => {
  assert.equal(getPrintable(), null);
  const print = () => {};
  registerPrintable(print);
  assert.equal(getPrintable(), print);
});

test("unmounting the pane takes the capability with it", () => {
  const off = registerPrintable(() => {});
  off();
  assert.equal(getPrintable(), null);
});

test("a stale cleanup cannot blank the pane that replaced it", () => {
  // React mounts the next pane before unmounting the old one often enough
  // that a cleanup which blindly cleared the slot would leave the palette
  // with no print row on a surface that has the button on screen
  const offOld = registerPrintable(() => {});
  const fresh = () => {};
  registerPrintable(fresh);
  offOld();
  assert.equal(getPrintable(), fresh);
});

test("subscribers hear every change, and stop when they unsubscribe", () => {
  let beats = 0;
  const off = subscribePrintable(() => (beats += 1));
  const offPane = registerPrintable(() => {});
  assert.equal(beats, 1);
  offPane();
  assert.equal(beats, 2);
  off();
  registerPrintable(() => {});
  assert.equal(beats, 2);
});
