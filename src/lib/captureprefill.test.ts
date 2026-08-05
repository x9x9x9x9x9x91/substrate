import { test } from "node:test";
import assert from "node:assert/strict";
import { resetCaptureBox, type CapturePrefillPort } from "./captureprefill.ts";

/** A capture box plus the backend's prefill slot. Reads resolve only when a
    test says so, so the test picks the interleaving. `consuming` models the
    take-on-read the review rejected — the pins below are the ones that fail if
    the backend ever goes back to it. */
function harness(prefill: string | null, opts: { consuming?: boolean } = {}) {
  let text = "not empty to start with";
  let slot = prefill;
  const pending: Array<() => void> = [];
  const port: CapturePrefillPort = {
    setText: (t) => {
      text = t;
    },
    readPrefill: () =>
      new Promise((resolve) => {
        // the slot is read when the command runs, i.e. at settle time
        pending.push(() => {
          const value = slot;
          if (opts.consuming) slot = null;
          resolve(value);
        });
      }),
  };
  return {
    port,
    /** Let the Nth outstanding read (0-based) resolve. */
    settle: async (i: number) => {
      pending[i]();
      // two microtask turns: the await in resetCaptureBox, then its setText
      await Promise.resolve();
      await Promise.resolve();
    },
    box: () => text,
  };
}

test("a reset clears the box, then refills it from the prefill", async () => {
  const h = harness("call the studio");
  const done = resetCaptureBox(h.port);
  assert.equal(h.box(), "", "the box must be cleared before the pull resolves");
  await h.settle(0);
  await done;
  assert.equal(h.box(), "call the studio");
});

test("a reset with no prefill leaves the box empty", async () => {
  const h = harness(null);
  const done = resetCaptureBox(h.port);
  await h.settle(0);
  await done;
  assert.equal(h.box(), "");
});

test("a failed read leaves the box cleared rather than throwing", async () => {
  let text = "stale";
  await resetCaptureBox({
    setText: (t) => {
      text = t;
    },
    readPrefill: () => Promise.reject(new Error("ipc down")),
  });
  assert.equal(text, "");
});

// SUB-1075 review finding 1. One `substrate://capture?text=…` link resets the
// capture window twice — `capture:prefill` fires immediately, `tauri://focus`
// whenever the window server delivers it — and each reset clears the box
// before its pull resolves. The second reset therefore lands its clear AFTER
// the first reset already filled the box, so the text only survives because
// the read is repeatable.
test("a second reset after the first finished still ends with the prefill", async () => {
  const h = harness("call the studio");
  const first = resetCaptureBox(h.port);
  await h.settle(0);
  await first;
  assert.equal(h.box(), "call the studio");

  const second = resetCaptureBox(h.port); // clears the filled box
  assert.equal(h.box(), "");
  await h.settle(1);
  await second;
  assert.equal(h.box(), "call the studio", "the second reset must re-read, not find it spent");
});

test("a consuming read loses it — why deeplink_capture_prefill must not take", async () => {
  const h = harness("call the studio", { consuming: true });
  const first = resetCaptureBox(h.port);
  await h.settle(0);
  await first;
  const second = resetCaptureBox(h.port);
  await h.settle(1);
  await second;
  // the spent slot reads back empty, so the second reset's clear is the last word
  assert.equal(h.box(), "");
});

test("two resets in flight converge whichever order their reads resolve", async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const h = harness("call the studio");
    const both = [resetCaptureBox(h.port), resetCaptureBox(h.port)];
    for (const i of order) await h.settle(i);
    await Promise.all(both);
    assert.equal(h.box(), "call the studio", `order ${order.join(",")}`);
  }
});
