/** A new row made while the database pane is showing its calendar layout,
    rendered for real through the component harness (`componentHarness.ts`,
    pattern in `docs/component-tests.md`).

    The grid places rows by the bound date property, so a row created with no
    value on it was made and then appeared nowhere — no chip, no feedback,
    nothing for the reader to reach. A row born on the calendar now takes the
    day the reader is looking at. Every other layout still creates dateless,
    which is the half this file pins hardest: the change is scoped to the one
    layout that needs a date to show anything. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { isoDay } from "./calendar.ts";
import { monthWindow } from "./calendarfence.ts";
import { dbLayoutEntries } from "./dbcalendarlayout.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Calendar Create";

const SCHEMA = {
  released: { kind: "date" },
} as unknown as Record<string, PropSchema>;

const { vaultList } = await import("./ipc.ts");

before(async () => {
  await mockBackend();
});

function row(title: string, day: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: DB, released: day },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

/** one existing row, so the database offers `released` as a date binding */
const NOTES = [row("Seed Row", "2026-01-15")];

function paneProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: DB,
    notes: NOTES,
    allNotes: NOTES,
    pref: { view: "calendar" },
    typeSchema: SCHEMA,
    schema: { [DB]: SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: [DB],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    onPrefChange: () => {},
    onOpenNote: () => {},
    onNoteMenu: () => {},
    onTrashNotes: () => {},
    onMutated: () => {},
    onSaveView: () => {},
    savedViews: [],
    pinKeys: {},
    onOpenView: () => {},
    onViewMenu: () => {},
    onRenameDb: () => {},
    onDeleteDb: () => {},
    onRenameProp: () => {},
    onRemoveProp: () => {},
    ...over,
  };
}

async function mountPane(
  t: Parameters<typeof renderComponent>[0],
  over: Record<string, unknown> = {}
) {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return renderComponent(t, h(DatabasePane as never, paneProps(over) as never));
}

/** The pane's own New-entry door — the same `startDraft` ⌘N reaches, so what
    this asserts is the ⌘N behaviour and not a second creation path. Types the
    title into the draft and commits it with Enter. */
async function createRow(
  r: Awaited<ReturnType<typeof renderComponent>>,
  title: string
): Promise<void> {
  await r.click(".db-new");
  const input = r.one(".db-draft-input") as HTMLInputElement | null;
  assert.ok(input, "the draft entry opened");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, title);
    input.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(
      new globalThis.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
  });
  await r.settle();
  await r.settle();
}

/** the created note as the vault holds it */
async function made(title: string): Promise<NoteMeta> {
  const note = (await vaultList()).find((n) => n.title === title);
  assert.ok(note, `“${title}” was created`);
  return note;
}

/** The days that month's grid would place the note on — the pane holds the
    rows it was handed, so this asks the layout itself rather than the DOM. */
function placedOn(note: NoteMeta, year: number, month0: number): string[] {
  return dbLayoutEntries(
    [note],
    { [DB]: SCHEMA } as never,
    "released",
    monthWindow(year, month0)
  ).map((e) => e.day);
}

function releasedOf(note: NoteMeta): string {
  const key = Object.keys(note.props).find((k) => k.toLowerCase() === "released");
  return key ? String(note.props[key]) : "";
}

test("a row made on the calendar is born on the day the reader is looking at", async (t) => {
  const r = await mountPane(t);
  await createRow(r, "Born Today");
  // the grid opens on the current month, so the day on screen is today
  const today = new Date();
  const note = await made("Born Today");
  assert.equal(releasedOf(note), isoDay(today));
  // and the month on screen places it, rather than nowhere at all
  assert.deepEqual(placedOn(note, today.getFullYear(), today.getMonth()), [isoDay(today)]);
});

test("a row made on a month the reader paged to is born on that month's first day", async (t) => {
  const r = await mountPane(t);
  await r.click('button[aria-label="Next month"]');
  await createRow(r, "Born Next Month");
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const note = await made("Born Next Month");
  assert.equal(releasedOf(note), isoDay(next));
  assert.deepEqual(placedOn(note, next.getFullYear(), next.getMonth()), [isoDay(next)]);
});

test("a row made on any other layout stays dateless", async (t) => {
  const r = await mountPane(t, { pref: { view: "table" } });
  await createRow(r, "Born Dateless");
  const note = await made("Born Dateless");
  assert.equal(releasedOf(note), "", "the table invents no date");
  const now = new Date();
  assert.deepEqual(placedOn(note, now.getFullYear(), now.getMonth()), [], "nothing to place");
});
