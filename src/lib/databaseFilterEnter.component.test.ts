/** Enter in the database filter input, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    The last expression typed sits in `parsedQuery.trailing` until its token
    ends, and the only thing that ended it was a space — Enter, the key a
    reader who has finished typing actually presses, did nothing at all. These
    pin that Enter finishes the expression, that a stub with no operand still
    commits nothing, and that Tab and Escape keep their own jobs. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const SCHEMA: Record<string, PropSchema> = {
  status: { options: [] },
  rating: { options: [], kind: "number" },
};

function row(title: string, status: string, rating: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: "Release", status, rating },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const ROWS = [row("Slow Bloom EP", "mixing", "9"), row("Dust Harbour", "live", "4")];

/** DatabasePane's required props, with everything these tests don't drive
    inert. Built loosely on purpose: the pane takes some thirty callbacks, and
    naming them all here would pin the prop list rather than the behaviour. */
function paneProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dbType: "Release",
    notes: ROWS,
    allNotes: ROWS,
    pref: { view: "list" },
    typeSchema: SCHEMA,
    schema: { Release: SCHEMA },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: ["Release"],
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

/** Type into the filter input — the harness synthesizes clicks only, so the
    value goes in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** One keydown, dispatched where React's root listener picks it up. */
async function press(field: Element, key: string): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** The filter bar renders only on demand — focus opens it. */
async function filterInput(r: { one(sel: string): Element | null }): Promise<HTMLInputElement> {
  const field = r.one(".db-filter-input");
  assert.ok(field, "the filter input is on screen");
  return field as HTMLInputElement;
}

async function openPane(t: Parameters<typeof renderComponent>[0], over?: Record<string, unknown>) {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const r = await renderComponent(t, h(DatabasePane as never, paneProps(over) as never));
  // the row renders on demand — the funnel is how a reader opens an empty one
  await r.click(".db-filter-toggle");
  return r;
}

test("Enter commits a key:value expression the reader has finished typing", async (t) => {
  const r = await openPane(t);
  const field = await filterInput(r);

  await type(field, "status:mixing");
  assert.ok(r.one(".search-completions"), "still a stub: the completion chips are up");

  await press(field, "Enter");
  const after = await filterInput(r);
  assert.equal(after.value, "status:mixing ", "the expression is committed, cursor on a fresh token");
  assert.match(r.text(), /Slow Bloom EP/, "the matching row is still there");
  assert.doesNotMatch(r.text(), /Dust Harbour/, "the filtered-out row is not");
  assert.equal(r.all(".search-completions").length, 0, "nothing is half-typed any more");
});

test("Enter commits a comparison", async (t) => {
  const r = await openPane(t);
  const field = await filterInput(r);

  await type(field, "rating >= 8");
  await press(field, "Enter");

  const after = await filterInput(r);
  assert.equal(after.value, "rating >= 8 ");
  assert.match(r.text(), /Slow Bloom EP/, "rating 9 clears the bar");
  assert.doesNotMatch(r.text(), /Dust Harbour/, "rating 4 does not");
});

test("a stub with no operand commits nothing", async (t) => {
  const r = await openPane(t);
  const field = await filterInput(r);

  for (const stub of ["status:", "rating >"]) {
    await type(field, stub);
    await press(field, "Enter");
    const after = await filterInput(r);
    assert.equal(after.value, stub, `${stub} is still being typed, not an empty filter`);
    // an empty filter would have hidden every row; the query still shows both
    assert.match(r.text(), /Slow Bloom EP/, "both rows are still listed");
    assert.match(r.text(), /Dust Harbour/);
  }
});

test("Tab still completes and Escape still clears", async (t) => {
  const r = await openPane(t);
  const field = await filterInput(r);

  await type(field, "status:mix");
  await press(field, "Tab");
  assert.equal((await filterInput(r)).value, "status:mixing ", "Tab took the first completion");

  await type(field, "stat");
  await press(field, "Tab");
  assert.equal((await filterInput(r)).value, "status:", "Tab one rung earlier opens the key");

  await press(field, "Escape");
  assert.equal((await filterInput(r)).value, "", "Escape emptied the query");
  assert.match(r.text(), /Slow Bloom EP/, "and every row is back");
  assert.match(r.text(), /Dust Harbour/);
});
