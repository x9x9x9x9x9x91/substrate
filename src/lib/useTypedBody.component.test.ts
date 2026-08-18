/** The live-value buffer sample, rendered for real through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    What is worth pinning is the CLEAR. The sample outranks the pane's
    disk-loaded body on purpose — a `` `= Cash.cash_total` `` span typed a
    second ago must resolve against the buffer, not against a file that has
    never mentioned that sheet. The cost of that ranking is that a body
    arriving from outside the editor (an external write adopted in place, a
    conflict resolved by taking disk, a rename's link sweep) leaves the sample
    holding text nobody can see, and live values keep resolving against it
    until the next keystroke. So the
    assertions follow the sample across an adopt: it goes, and a sample still
    sitting in its quiet period goes with it.

    The hook's 400ms timer is driven rather than waited out, by replacing the
    jsdom window's `setTimeout` with a queue the test pumps — the hook is the
    only thing in this render that schedules on the window. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";

/** Window timers captured instead of run — see the header. */
function captureWindowTimers(t: { after(fn: () => void): void }): Array<() => void> {
  const queued: Array<() => void> = [];
  const win = window as unknown as Record<string, unknown>;
  const realSet = win.setTimeout;
  const realClear = win.clearTimeout;
  let cleared = new Set<number>();
  win.setTimeout = (fn: () => void) => {
    const id = queued.length;
    queued.push(() => {
      if (!cleared.has(id)) fn();
    });
    return id;
  };
  win.clearTimeout = (id: number) => {
    cleared.add(id);
  };
  t.after(() => {
    win.setTimeout = realSet;
    win.clearTimeout = realClear;
    cleared = new Set();
  });
  return queued;
}

interface Handle {
  sample: (path: string, body: string) => void;
  clear: () => void;
}

/** Renders the hook against `path` and hands back both the visible body it
    resolves to and the two calls the pane makes on it. */
async function mountTypedBody(t: Parameters<typeof renderComponent>[0], path: string) {
  const { useTypedBody } = await import("../hooks/useTypedBody.ts");
  const handle: Handle = { sample: () => {}, clear: () => {} };

  function Harness({ notePath }: { notePath: string }) {
    const typed = useTypedBody(notePath);
    handle.sample = typed.sample;
    handle.clear = typed.clear;
    // the pane's own fallback: sample first, disk body second
    return h("span", { className: "live-body" }, typed.body ?? "<disk>");
  }

  const rendered = await renderComponent(t, h(Harness, { notePath: path }));
  const body = () => rendered.one(".live-body")?.textContent ?? "";
  return { rendered, handle, body };
}

/** Drive something that updates state from outside React — a fired timer, a
    call the pane makes — and let the render it causes land. */
async function drive(rendered: { settle(): Promise<void> }, fn: () => void) {
  await act(async () => {
    fn();
  });
  await rendered.settle();
}

test("a settled sample outranks the disk body", async (t) => {
  const queued = captureWindowTimers(t);
  const { rendered, handle, body } = await mountTypedBody(t, "Note.md");

  assert.equal(body(), "<disk>", "nothing sampled yet");
  await drive(rendered, () => handle.sample("Note.md", "= Cash.cash_total"));
  assert.equal(body(), "<disk>", "the sample waits out its quiet period");

  const fire = queued.shift();
  assert.ok(fire, "the hook scheduled no sample");
  await drive(rendered, fire);
  assert.equal(body(), "= Cash.cash_total");
});

test("an adopted body clears the sample", async (t) => {
  const queued = captureWindowTimers(t);
  const { rendered, handle, body } = await mountTypedBody(t, "Note.md");

  await drive(rendered, () => handle.sample("Note.md", "= Cash.cash_total"));
  const fire = queued.shift();
  assert.ok(fire);
  await drive(rendered, fire);
  assert.equal(body(), "= Cash.cash_total");

  // an external write lands: NotePane adopts the disk body and clears
  await drive(rendered, () => handle.clear());
  assert.equal(body(), "<disk>", "the stale buffer no longer shadows the adopted body");
});

test("clearing cancels a sample still in its quiet period", async (t) => {
  const queued = captureWindowTimers(t);
  const { rendered, handle, body } = await mountTypedBody(t, "Note.md");

  await drive(rendered, () => handle.sample("Note.md", "= Cash.cash_total"));
  await drive(rendered, () => handle.clear());

  // the timer the keystroke armed still fires — it must land on nothing,
  // or the adopt would be undone a beat after it happened
  for (const fire of queued.splice(0)) await drive(rendered, fire);
  assert.equal(body(), "<disk>");
});

test("a sample held for another note never bleeds across", async (t) => {
  const queued = captureWindowTimers(t);
  const { rendered, handle, body } = await mountTypedBody(t, "Note.md");

  await drive(rendered, () => handle.sample("Other.md", "= Holdings.total"));
  const fire = queued.shift();
  assert.ok(fire);
  await drive(rendered, fire);
  assert.equal(body(), "<disk>");
});
