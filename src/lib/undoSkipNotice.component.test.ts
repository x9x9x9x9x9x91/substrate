/** What ⌘Z says when an external edit has staled the action it was aimed at.
 *
 *  The stack keeps a staled entry and walks past it (docs/undo.md §3.3
 *  skip-and-show), so the keystroke lands on an OLDER action and undoes that
 *  one instead. Undoing something is not what "nothing happened" looks like:
 *  with nothing said, ⌘Z reads as having taken back the wrong edit. The notice
 *  is what makes the skip legible, and it rides the toast the run already
 *  shows — the app has ONE toast slot, so a notice raised before the write
 *  would be overwritten by "Undid …" the moment the write landed.
 *
 *  Mounted as the whole app on purpose, which `docs/component-tests.md` calls
 *  the exception: the seam is a message composed from stack state the moment
 *  a keystroke arrives, and no rendered pixel below App reveals it. It writes
 *  to the shared mock vault, so this file holds nothing else. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
});

type App = Awaited<ReturnType<typeof renderComponent>>;

/** the `data-fc` of a column, read off the rendered header */
function colOf(r: App, name: string): number {
  const labels = r.all("th .db-th-label").map((b) => b.getAttribute("aria-label") ?? "");
  const i = labels.indexOf(`Sort by ${name}`);
  assert.ok(i >= 0, `no ${name} column among ${labels.join(", ")}`);
  return i + 1;
}

/** click a checkbox cell: the smallest edit in the app that records an undo
    entry, and the one that names exactly one path */
async function toggle(r: App, col: number, row: number): Promise<string> {
  const cell = r.one(`td[data-fc="${col}"][data-fr="${row}"]`);
  assert.ok(cell, `no cell at column ${col}, row ${row}`);
  const path = cell.closest("tr")?.querySelector("td[data-focus-path]")?.getAttribute("data-focus-path");
  assert.ok(path, `row ${row} carried no path`);
  await r.click(cell);
  await r.settle();
  return path;
}

/** the inventory database, reached through the manager the sidebar's "All
    databases" row opens — it carries the app's one checkbox column */
async function openInventory(r: App): Promise<void> {
  const manager = r.all(".sidebar button").find((b) => b.textContent?.trim() === "All databases");
  assert.ok(manager, "the sidebar offered no database manager");
  await r.click(manager);
  await r.settle();
  const row = r
    .all(".dbmgr-row-main")
    .find((el) => (el.textContent ?? "").includes("Inventory"));
  assert.ok(row, "the database manager listed no inventory database");
  await r.click(row);
  await r.settle();
}

async function pressUndo(r: App): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })
    );
  });
  await r.settle();
}

function toastText(r: App): string {
  return (r.one(".toast")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

test("⌘Z names the action an external edit made it walk past", async (t) => {
  const { default: App } = await import("../App.tsx");
  const r = await renderComponent(t, h(App as never, {} as never));

  await openInventory(r);

  const col = colOf(r, "In use");
  // two edits, oldest first — ⌘Z is aimed at the second
  const older = await toggle(r, col, 0);
  const newer = await toggle(r, col, 1);
  assert.notEqual(older, newer, "both edits landed on the same row");

  /* Somebody else rewrites the newer row — a sync pull naming its paths is
     the unambiguous external write, no echo-window guessing involved. The
     entry that would take that edit back is now unsafe. */
  await act(async () => {
    win.__mockEmit?.("vault:pulled", [newer]);
  });
  await r.settle();

  await pressUndo(r);
  const said = toastText(r);
  assert.match(said, /^Skipped /, `⌘Z skipped in silence — it said “${said}”`);
  assert.match(said, /changed on disk/, `the skip gave no reason — it said “${said}”`);
  assert.match(said, /Undid /, `the skip never said what it DID do — it said “${said}”`);
});

test("⌘Z with nothing staled says only what it did", async (t) => {
  const { default: App } = await import("../App.tsx");
  const r = await renderComponent(t, h(App as never, {} as never));

  await openInventory(r);

  await toggle(r, colOf(r, "In use"), 2);
  await pressUndo(r);
  const said = toastText(r);
  assert.match(said, /Undid /, `an ordinary undo said “${said}”`);
  assert.doesNotMatch(said, /Skipped /, `an ordinary undo cried skip — it said “${said}”`);
});

/* Deletes a row from the mock vault, so it goes last in the file. */
test("a skip forced by a FAILED undo does not blame the disk", async (t) => {
  const { default: App } = await import("../App.tsx");
  const r = await renderComponent(t, h(App as never, {} as never));

  await openInventory(r);

  const col = colOf(r, "In use");
  const older = await toggle(r, col, 3);
  const newer = await toggle(r, col, 4);
  assert.notEqual(older, newer, "both edits landed on the same row");

  /* The newer row's note is gone by the time its inverse runs — the entry's
     own write throws, which is the OTHER way an entry goes stale. Nothing
     changed on disk under it in the sync sense, and nothing announced a
     thing: this is the app's own write failing. */
  win.__mockDeleteNote(newer);
  await pressUndo(r);
  const failed = toastText(r);
  assert.match(failed, /^Undo failed: /, `the failed inverse said “${failed}”`);

  // the next ⌘Z walks past it to the older edit, and has to say WHY that one
  // was passed over without inventing a disk conflict
  await pressUndo(r);
  const said = toastText(r);
  assert.match(said, /^Skipped /, `⌘Z skipped in silence — it said “${said}”`);
  assert.match(said, /Undid /, `the skip never said what it DID do — it said “${said}”`);
  assert.match(
    said,
    /failed earlier/,
    `the skip gave the wrong reason for a failed undo — it said “${said}”`
  );
  assert.doesNotMatch(
    said,
    /changed on disk/,
    `a write that errored was reported as a sync conflict — it said “${said}”`
  );
});
