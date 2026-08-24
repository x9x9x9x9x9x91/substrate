/** "+ row" writes nothing until a cell is filled, pinned on the real grid
    (`SheetGrid.tsx`).

    A tap used to append a row of empty cells to the note immediately, and
    nothing ever trimmed it: the row round-trips through the csv serializer
    forever. That is not merely untidy — every per-row formula then derives
    over its blanks, so a `TODAY() - <date>` column turns today's date into
    that row's value and a numeric criteria over the column meets text and
    hard-errors, taking a dashboard card down with it. The placeholder now
    lives in the grid until the first commit, and only a non-empty commit
    turns it into a row the note carries. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

/* The shape the finance dashboards read: a date column with a per-row age
   derived off it. Two rows, no blanks. */
const BODY =
  "```csv\nasset,verified\nBTC,2026-08-20\nETH,2026-08-22\n```\n\n" +
  "```formulas\nage_days = TODAY() - verified\n```\n";

const meta: NoteMeta = {
  path: "Draft Row.md",
  stem: "Draft Row",
  title: "Draft Row",
  folder: "",
  props: { Type: "Sheet" },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

let win: MockWindow;
before(async () => {
  win = await mockBackend();
});

/** Type into a field: the harness synthesizes clicks only, so the value goes
    in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fire(el: Element, event: Event): Promise<void> {
  await act(async () => {
    el.dispatchEvent(event);
  });
}

test("“+ row” shows a row the note only learns about when a cell is filled", async (t) => {
  assert.ok(win, "mock backend installed");
  const { default: SheetGrid } = await import("../components/SheetGrid.tsx");
  const written: string[] = [];
  const r = await renderComponent(
    t,
    h(SheetGrid, {
      meta,
      initial: BODY,
      vaultEpoch: 0,
      onChange: (body: string) => written.push(body),
      onFollowLink: () => {},
    })
  );

  const dataRows = () => r.all("tbody tr:not(.sheet-addrow):not(.sheet-totals)");
  assert.equal(dataRows().length, 2, "the note's two rows");

  await r.click(".sheet-addrow button");
  assert.deepEqual(written, [], "the tap wrote nothing to the note");
  assert.equal(dataRows().length, 3, "but the row is there to type into");
  const placeholder = dataRows()[2];
  assert.equal(
    (placeholder.textContent ?? "").trim(),
    "",
    "every cell blank — including the derived one, which must not read as today's date"
  );

  /* Fill it: the row buys its place in the note with the first real value. */
  const firstCell = placeholder.querySelector(".sheet-cell");
  assert.ok(firstCell, "the placeholder's first cell is focusable");
  await fire(firstCell, new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const input = r.one(".sheet-input");
  assert.ok(input, "double-click opened the cell editor");
  await type(input, "SOL");
  await fire(input, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await r.settle();

  assert.equal(written.length, 1, "exactly one write, and only once there was something to write");
  assert.match(written[0], /\nSOL,\n/, "the row landed with the typed value");
  assert.doesNotMatch(written[0], /\n,\n/, "and no all-blank row rode along with it");
  assert.equal(dataRows().length, 3, "the placeholder became the row, it did not add another");
});

test("an abandoned “+ row” leaves the note alone", async (t) => {
  const { default: SheetGrid } = await import("../components/SheetGrid.tsx");
  const written: string[] = [];
  const r = await renderComponent(
    t,
    h(SheetGrid, {
      meta,
      initial: BODY,
      vaultEpoch: 0,
      onChange: (body: string) => written.push(body),
      onFollowLink: () => {},
    })
  );

  const dataRows = () => r.all("tbody tr:not(.sheet-addrow):not(.sheet-totals)");
  await r.click(".sheet-addrow button");
  const firstCell = dataRows()[2].querySelector(".sheet-cell");
  assert.ok(firstCell, "the placeholder is there");
  /* Open the cell and commit nothing — the shape a user leaves behind by
     tapping "+ row" and walking away. */
  await fire(firstCell, new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const input = r.one(".sheet-input");
  assert.ok(input, "the cell editor opened");
  await fire(input, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await r.settle();

  assert.deepEqual(written, [], "an empty commit writes nothing at all");
  assert.equal(dataRows().length, 3, "the placeholder stays put, ready for a value");
});
