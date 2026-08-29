/** ⌘⌫ on the calendar, rendered for real (the harness pattern is written up in
    `docs/component-tests.md`).

    Deletion used to be mouse-only — right-click a chip, or open its peek and
    press Delete. The chord is the keyboard twin of that menu row, and the two
    halves worth pinning are the ones a type check cannot see: it trashes the
    event the calendar is visibly tinting as selected, and on a repeating
    occurrence it refuses to guess, opening the chip menu whose rows say which
    occurrences the user means. */

import assert from "node:assert/strict";
import { test, before } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

/** the peek and the context menu portal to the body, outside the container */
const one = (sel: string) => document.body.querySelector(sel);
const bodyText = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

/** today, so the chip lands on the month grid the pane opens on */
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function note(path: string, props: Record<string, unknown>): NoteMeta {
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return {
    path,
    stem,
    title: stem,
    folder: "Events",
    props: { type: "event", ...props },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const ONCE = "Events/Studio Block.md";
const SERIES = "Events/Weekly Sync.md";

/** the chord as it arrives from a real keyboard: ⌘⌫, no other modifier */
async function pressTrashChord(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

/** render the calendar over both fixtures and hand back what it asked App to
    trash. Clicking a chip is what selects an event — the same click that opens
    its peek. */
async function calendar(t: Parameters<typeof renderComponent>[0]) {
  const trashed: string[] = [];
  const { default: CalendarPane } = await import("../components/CalendarPane.tsx");
  const r = await renderComponent(
    t,
    h(CalendarPane, {
      notes: [
        note(ONCE, { date: todayIso() }),
        note(SERIES, { date: todayIso(), repeat: "weekly" }),
      ],
      schema: {},
      newSignal: 0,
      onOpenNote: () => {},
      onMutated: () => {},
      onTrashNote: (path: string) => trashed.push(path),
      onRenameNote: async () => {},
      onOpenJournal: () => {},
      upcomingDock: "bottom" as const,
    }),
  );
  return { r, trashed };
}

/** the chip for a title, on whichever surface the pane opened on */
function chip(r: { all: (s: string) => Element[] }, title: string): Element {
  const el = r
    .all(".cal-entry")
    .find((c) => (c.textContent ?? "").includes(title));
  assert.ok(el, `a chip for ${title}`);
  return el;
}

before(async () => {
  await mockBackend();
});

test("⌘⌫ trashes the selected event", async (t) => {
  const { r, trashed } = await calendar(t);
  await r.click(chip(r, "Studio Block"));
  assert.ok(one(".cal-peek"), "clicking the chip selects it and opens the peek");
  await pressTrashChord();
  assert.deepEqual(trashed, [ONCE]);
});

test("⌘⌫ with nothing selected deletes nothing", async (t) => {
  const { r, trashed } = await calendar(t);
  assert.equal(one(".cal-peek"), null);
  await pressTrashChord();
  assert.deepEqual(trashed, []);
  // and the pane is still there — the chord fell through, it didn't throw
  assert.ok(r.one(".cal-entry"));
});

test("⌘⌫ on a repeating occurrence asks which occurrences, never trashes the series", async (t) => {
  const { r, trashed } = await calendar(t);
  await r.click(chip(r, "Weekly Sync"));
  await pressTrashChord();
  assert.deepEqual(trashed, [], "the series is not deleted behind the user's back");
  const menu = one(".ctx-menu");
  assert.ok(menu, "the chip menu opens instead");
  const text = bodyText();
  for (const row of [
    "Skip this occurrence",
    "Delete this and following",
    "Delete all occurrences",
  ]) {
    assert.ok(text.includes(row), row);
  }
});
