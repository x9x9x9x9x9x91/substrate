import { test } from "node:test";
import assert from "node:assert/strict";
import { ringChipText, ringStats, ringVerdict } from "./jobring.ts";

test("ringStats counts nonzero exits as failures", () => {
  assert.deepEqual(ringStats([]), { runs: 0, failed: 0 });
  assert.deepEqual(ringStats([0, 0, 0]), { runs: 3, failed: 0 });
  assert.deepEqual(ringStats([1, 0, 137, 0, 2]), { runs: 5, failed: 3 });
});

test("ringVerdict stays silent below two runs or without failures", () => {
  // a single observation adds nothing over the row's own exit chip
  assert.equal(ringVerdict([1]), null);
  assert.equal(ringVerdict([0]), null);
  assert.equal(ringVerdict([]), null);
  assert.equal(ringVerdict([0, 0, 0, 0]), null);
});

test("ringVerdict alerts on a failing majority, warns otherwise", () => {
  // the case: one lucky success must not repaint a week of failures
  assert.equal(ringVerdict([1, 1, 1, 1, 0]), "alert");
  assert.equal(ringVerdict([1, 1]), "alert");
  assert.equal(ringVerdict([1, 0]), "warn");
  assert.equal(ringVerdict([0, 1, 0, 0, 0]), "warn");
  // exactly half is not a majority
  assert.equal(ringVerdict([1, 0, 1, 0]), "warn");
});

test("ringChipText reads like the brief's example", () => {
  assert.equal(ringChipText([1, 1, 0, 1, 1]), "4 of last 5 runs failed");
  assert.equal(ringChipText([0, 1, 0]), "1 of last 3 runs failed");
  assert.equal(ringChipText([1, 0]), "1 of last 2 runs failed");
});
