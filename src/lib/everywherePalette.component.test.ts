/** The everywhere palette window rendered for real, over a staged context
    snapshot.

    The chip's own decisions — what it says, which frontmatter it becomes —
    are pinned in `capturecontext.test.ts`; this pins that the palette window
    reaches for them at all, and that with nothing armed (the off-by-default
    flag, where the backend answers `context_pending` with null) the window is
    the window it always was. The e2e spec walks the same ground in a browser;
    this is the cheap rung that runs on every test gate.

    Written up in `docs/component-tests.md`. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

let win: MockWindow;
before(async () => {
  win = await mockBackend();
});

const CHIP = "[data-testid=palette-context-chip]";

const ABLETON = {
  app: "Ableton Live 12 Suite",
  doc: "MyTrack",
  file: "/Users/a/Music/Sets/MyTrack Project/MyTrack.als",
};

/** Stage what the backend armed for this summon, then mount the window. */
async function palette(t: Parameters<typeof renderComponent>[0], snap: typeof ABLETON | null) {
  win.__mockSetContext?.(snap);
  win.__mockTraceCommands?.();
  const { PaletteApp } = await import("../palette.tsx");
  return renderComponent(t, h(PaletteApp as never));
}

/** value goes in through the native setter React's onChange listens behind */
async function typeInto(el: Element, value: string): Promise<void> {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The capture row is always last in the list (`lib/everywhere.ts`), and Enter
    only reaches it once the selection walks down — so the file gesture here is
    a click on that row, which runs the same handler. */
async function fileIt(r: Awaited<ReturnType<typeof renderComponent>>): Promise<void> {
  const rows = r.all(".palette-item");
  await r.click(rows[rows.length - 1]);
  await r.settle();
}

async function press(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** create-time props of the last note this window filed */
function lastFiledProps(): [string, string][] {
  const trace = (win.__mockReadCommandTrace?.() ?? []) as {
    cmd: string;
    props?: [string, string][];
  }[];
  const creates = trace.filter((e) => e.cmd === "vault_create");
  assert.ok(creates.length > 0, "the window filed a note");
  return creates[creates.length - 1].props ?? [];
}

test("an armed snapshot renders the chip and rides the filed note", async (t) => {
  const r = await palette(t, ABLETON);
  const chip = r.one(CHIP);
  assert.ok(chip, "the palette renders a context chip while one is armed");
  // the set names itself — not four folders of path in a narrow window
  assert.match(chip.textContent ?? "", /MyTrack\.als/);
  // and the footer says how to decline it
  assert.match(r.text(), /drop context/);

  const input = r.one(".palette-input")!;
  await typeInto(input, "a thought about the arrangement");
  await r.settle();
  await fileIt(r);

  assert.deepEqual(lastFiledProps(), [
    ["context-app", "Ableton Live 12 Suite"],
    ["context-doc", "MyTrack"],
    ["context-file", "/Users/a/Music/Sets/MyTrack Project/MyTrack.als"],
  ]);
});

test("Backspace on an empty box drops the chip, and the note files without it", async (t) => {
  const r = await palette(t, ABLETON);
  const input = r.one(".palette-input")!;
  assert.ok(r.one(CHIP));

  await press(input, "Backspace");
  await r.settle();
  assert.equal(r.one(CHIP), null, "the chip is gone once it has been declined");
  assert.doesNotMatch(r.text(), /drop context/);

  await typeInto(input, "a thought with no context");
  await r.settle();
  await fileIt(r);
  assert.deepEqual(lastFiledProps(), []);
});

test("nothing armed, no chip — the flag-off palette is the palette it always was", async (t) => {
  const r = await palette(t, null);
  assert.equal(r.one(CHIP), null);
  assert.doesNotMatch(r.text(), /drop context/);

  const input = r.one(".palette-input")!;
  await typeInto(input, "a plain thought");
  await r.settle();
  await fileIt(r);
  assert.deepEqual(lastFiledProps(), []);
});

test("a pasted link keeps the chip out of the way — url_capture carries no props", async (t) => {
  const r = await palette(t, ABLETON);
  const input = r.one(".palette-input")!;
  assert.ok(r.one(CHIP));

  await typeInto(input, "https://example.com/a-page");
  await r.settle();
  assert.equal(r.one(CHIP), null, "a link files through the path that has no props");
});
