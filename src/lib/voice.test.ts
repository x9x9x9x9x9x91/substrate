import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCARD_CONFIRM_MS, escapeHint, voiceEscape } from "./voice.ts";

test("a short recording discards on the first Escape", () => {
  assert.equal(voiceEscape(0, false), "discard");
  assert.equal(voiceEscape(DISCARD_CONFIRM_MS - 1, false), "discard");
});

test("past the threshold Escape asks first, and the second one discards", () => {
  assert.equal(voiceEscape(DISCARD_CONFIRM_MS, false), "confirm");
  assert.equal(voiceEscape(9 * 60_000, false), "confirm");
  // the armed Escape must discard however long the recording has run
  assert.equal(voiceEscape(9 * 60_000, true), "discard");
});

test("the armed state is visible in the foot hint", () => {
  assert.notEqual(escapeHint(true), escapeHint(false));
  assert.match(escapeHint(true), /again/);
});
