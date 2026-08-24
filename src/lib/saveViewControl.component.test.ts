/** The save-view control rendered for real, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    Saving a view upserts by name, and the name field opens SEEDED with the
    open pin's name — so the ordinary press replaces that pin, and the control
    said nothing about it. The label only exists at typing time, which is
    exactly where tsc and the browser specs both walk past it. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SavedView } from "./types.ts";

const PINS: SavedView[] = [
  { id: "weekly", name: "Weekly", db: "Release", query: "status:mastering" },
];

function row(title: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: "Release" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

/** DatabasePane's required props, with everything this test doesn't drive
    inert. Built loosely on purpose: the pane takes some thirty callbacks, and
    naming them all here would pin the prop list rather than the behaviour. */
function paneProps(over: Record<string, unknown>): Record<string, unknown> {
  return {
    dbType: "Release",
    notes: [row("Slow Bloom EP")],
    allNotes: [row("Slow Bloom EP")],
    pref: { view: "table" },
    typeSchema: {},
    schema: { Release: {} },
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
    savedViews: PINS,
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

/** Type into the naming field — the harness synthesizes clicks only, so the
    value goes in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Commit the open naming field the way a reader does: Enter. */
async function commit(field: Element): Promise<void> {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

test("the seeded name of an open pin says it updates that pin, not pins a new one", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const r = await renderComponent(
    t,
    h(DatabasePane as never, paneProps({ saveViewSeed: "Weekly", activeViewId: "weekly" }) as never)
  );

  await r.click(".db-tab-add");
  const field = r.one(".inline-edit");
  assert.ok(field, "the naming field opened");
  assert.equal((field as HTMLInputElement).value, "Weekly", "seeded with the open pin's name");
  assert.match(
    r.text(),
    /Updates “Weekly”/,
    "the press would replace the pin, so the control says so"
  );
});

test("the label follows the typed name in and out of a match", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const r = await renderComponent(t, h(DatabasePane as never, paneProps({}) as never));

  await r.click(".db-tab-add");
  const field = r.one(".inline-edit");
  assert.ok(field, "the naming field opened");
  // an unseeded name is a new pin: nothing to say
  assert.ok(r.one(".db-filter"), "the naming row is on screen");
  assert.doesNotMatch(r.text(), /Updates/, "a blank name would pin a new view");

  await type(field, "Weekly");
  assert.match(r.text(), /Updates “Weekly”/, "typing an existing pin's name is an overwrite");

  // matching folds case, but the save stores the name as typed — so this
  // press renames the pin as well as replacing it, and the label says both
  await type(field, "  weekly ");
  assert.match(r.text(), /Updates “Weekly” → “weekly”/);

  await type(field, "Weekly 2");
  assert.ok(r.one(".inline-edit"), "the field is still open");
  assert.doesNotMatch(r.text(), /Updates/, "a free name is a new pin again");
});

test("a pin of another database is not this database's overwrite", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  /* App hands the pane its own database's pins; the hint asks the same
     question the upsert does, so a stray foreign pin can't claim the name. */
  const r = await renderComponent(
    t,
    h(
      DatabasePane as never,
      paneProps({
        savedViews: [{ id: "weekly-gear", name: "Weekly", db: "Gear" }] as SavedView[],
      }) as never
    )
  );

  await r.click(".db-tab-add");
  const field = r.one(".inline-edit");
  assert.ok(field, "the naming field opened");
  await type(field, "Weekly");
  assert.ok(r.one(".inline-edit"), "the field is still open");
  assert.doesNotMatch(r.text(), /Updates/);
});

test("updating an open pin confirms the write", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const saved: string[] = [];
  const r = await renderComponent(
    t,
    h(
      DatabasePane as never,
      paneProps({
        saveViewSeed: "Weekly",
        activeViewId: "weekly",
        onSaveView: (name: string) => saved.push(name),
      }) as never
    )
  );

  await r.click(".db-tab-add");
  const field = r.one(".inline-edit");
  assert.ok(field, "the naming field opened");
  await commit(field);

  assert.deepEqual(saved, ["Weekly"], "the pin was written");
  assert.ok(r.one(".db-filter-saved"), "and the row says so");
  assert.match(r.text(), /Saved/);
  assert.equal(r.all(".inline-edit").length, 0, "the naming field closed behind it");
});

test("pinning a new view confirms the same way", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const saved: string[] = [];
  const r = await renderComponent(
    t,
    h(DatabasePane as never, paneProps({ onSaveView: (name: string) => saved.push(name) }) as never)
  );

  await r.click(".db-tab-add");
  const field = r.one(".inline-edit");
  assert.ok(field, "the naming field opened");
  await type(field, "Weekly 2");
  await commit(field);

  assert.deepEqual(saved, ["Weekly 2"], "a fresh name pins a new view");
  assert.ok(r.one(".db-filter-saved"), "the new pin confirms like an update does");
  assert.match(r.text(), /Saved/);
});

test("the confirmation is transient, and a cancelled name gets none", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const saved: string[] = [];
  const r = await renderComponent(
    t,
    h(
      DatabasePane as never,
      paneProps({ saveViewSeed: "Weekly", onSaveView: (name: string) => saved.push(name) }) as never
    )
  );

  // escaping out of the field wrote nothing, so there is nothing to confirm
  await r.click(".db-tab-add");
  const field = r.one(".inline-edit");
  assert.ok(field, "the naming field opened");
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  assert.deepEqual(saved, [], "nothing was written");
  assert.equal(r.all(".db-filter-saved").length, 0, "and nothing was confirmed");

  // a real save confirms, then puts the row back on its own
  await r.click(".db-tab-add");
  const second = r.one(".inline-edit");
  assert.ok(second, "the naming field reopened");
  await commit(second);
  assert.ok(r.one(".db-filter-saved"), "the write is confirmed");

  await act(async () => {
    await new Promise((done) => setTimeout(done, 2000));
  });
  assert.equal(r.all(".db-filter-saved").length, 0, "the word is gone again");
  assert.deepEqual(saved, ["Weekly"], "and it was one save, not two");
});
