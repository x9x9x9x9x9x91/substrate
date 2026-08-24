/** ⌘F in a database pane, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    The filter bar was reachable by mouse only — the funnel toggle — while the
    one chord every reader already knows for "find in what I am looking at"
    did nothing anywhere in the app outside a note's editor. These pin that ⌘F
    opens the row, lands the caret in it, and narrows as the reader types; that
    the chord is the pane's and not the window's, so a second pane on screen
    without focus stays shut; and that ⌘⇧F, global search, is still not this. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent, type Rendered } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const SCHEMA: Record<string, PropSchema> = {
  status: { options: [] },
};

function row(title: string, status: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: { type: "Release", status },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const ROWS = [row("Slow Bloom EP", "mixing"), row("Dust Harbour", "live")];

/** DatabasePane's required props, with everything these tests don't drive
    inert — the loose shape `databaseFilterEnter.component.test.ts` uses, for
    the same reason: the pane takes some thirty callbacks and naming them all
    would pin the prop list rather than the behaviour. */
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

async function openPane(
  t: Parameters<typeof renderComponent>[0],
  over?: Record<string, unknown>
): Promise<Rendered> {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  return renderComponent(t, h(DatabasePane as never, paneProps(over) as never));
}

/** One chord, dispatched at the window the way the browser delivers it to a
    capture listener — nothing in the pane has to have focus for it to arrive. */
async function chord(r: Rendered, key: string, mods: { shiftKey?: boolean } = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, ...mods })
    );
  });
  await r.settle();
}

/** Type into the filter input — the harness synthesizes clicks only, so the
    value goes in through the native setter React's onChange listens behind. */
async function type(field: Element, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("⌘F opens the filter row and lands the caret in it", async (t) => {
  const r = await openPane(t);
  assert.equal(r.one(".db-filter-input"), null, "the row starts closed — no query, no focus");

  await chord(r, "f");

  const field = r.one(".db-filter-input");
  assert.ok(field, "the filter row is on screen");
  assert.equal(document.activeElement, field, "and the caret is in it");

  // the whole point of opening it: what is typed narrows the rows at once
  await type(field, "status:mixing ");
  await r.settle();
  assert.match(r.text(), /Slow Bloom EP/, "the matching row stays");
  assert.doesNotMatch(r.text(), /Dust Harbour/, "the other one is filtered out");
});

test("⌘F on an already-open row selects the query it finds there", async (t) => {
  const r = await openPane(t);
  await r.click(".db-filter-toggle");
  const field = r.one(".db-filter-input") as HTMLInputElement;
  await type(field, "status:live ");
  await act(async () => {
    field.blur();
  });

  await chord(r, "f");

  const after = r.one(".db-filter-input") as HTMLInputElement;
  assert.equal(document.activeElement, after, "the caret came back to the field");
  assert.equal(after.value, "status:live ", "the query is untouched…");
  assert.equal(after.selectionStart, 0, "…and selected whole, so the next keystroke replaces it");
  assert.equal(after.selectionEnd, "status:live ".length);
});

test("only the pane with focus answers the chord", async (t) => {
  const first = await openPane(t);
  const second = await openPane(t);

  // focus something inert inside the SECOND pane — its "All" tab
  const tab = second.one(".db-tab") as HTMLElement;
  assert.ok(tab, "the tab strip is there to focus");
  await act(async () => {
    tab.focus();
  });
  assert.equal(document.activeElement, tab, "focus is inside the second pane");

  await chord(second, "f");
  await first.settle();

  assert.ok(second.one(".db-filter-input"), "the focused pane opened its filter");
  assert.equal(first.one(".db-filter-input"), null, "the other pane stayed shut");
});

test("⌘⇧F is global search, not this", async (t) => {
  const r = await openPane(t);
  await chord(r, "F", { shiftKey: true });
  assert.equal(r.one(".db-filter-input"), null, "the filter row is still closed");
});
