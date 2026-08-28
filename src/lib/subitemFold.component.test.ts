/** Folding a sub-item parent, rendered for real through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A fold is a VIEW state: it takes a parent's children off the screen, not
    out of the database. Two things downstream of the table's row list read
    the wrong one of the two orders if that principle is only half applied,
    and neither is reachable from tsc or from a browser spec that never folds
    with rows selected:

      1. The prune effect that drops selection entries and write-failure
         marks for rows that vanished. Keyed on the PAINTED rows, a fold
         silently shrinks a multi-selection — the bulk bar keeps saying "2
         selected" for one frame, and the next ⌘⌫ trashes fewer notes than
         the user chose — and permanently drops a child's "not saved" reason.
      2. The group header's count. Keyed on the painted rows it shrinks under
         a fold while the footer tally beside it (which reads the full order)
         does not: two disagreeing counts of the same notes on one screen. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, PropSchema } from "./types.ts";

const DB = "Task";

/** The schema of a database that marks its self-relation as the parent link:
    the reserved `parent` key rides inside the flat prop map, as on disk. */
const TREE_SCHEMA = {
  parent: "Parent task",
  "Parent task": { options: [], kind: "relation", type: DB },
  Stage: { options: [{ value: "live" }] },
} as unknown as Record<string, PropSchema>;

function row(title: string, parent?: string): NoteMeta {
  return {
    path: `${title}.md`,
    stem: title,
    title,
    folder: "",
    props: {
      type: DB,
      Stage: "live",
      ...(parent ? { "Parent task": parent } : {}),
    },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

/* Vesna nests under Ivo; both sit in the one "live" section. */
const NOTES = [row("Ivo"), row("Vesna", "Ivo")];

/** DatabasePane's required props, with everything these tests don't drive
    inert — built loosely on purpose, like the save-view control's harness:
    the pane takes some thirty callbacks and naming them all would pin the
    prop list rather than the behaviour. */
function paneProps(over: Record<string, unknown>): Record<string, unknown> {
  return {
    dbType: DB,
    notes: NOTES,
    allNotes: NOTES,
    pref: { view: "table" },
    typeSchema: TREE_SCHEMA,
    schema: { [DB]: TREE_SCHEMA },
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

/** A modified click is the pane's selection gesture — the harness's own
    `click` carries no modifier, so this dispatches the event itself. */
async function metaClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
  });
}

test("folding a parent keeps its children in the selection", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const r = await renderComponent(t, h(DatabasePane as never, paneProps({}) as never));

  const titles = r.all("td.db-title");
  assert.equal(titles.length, 2, "parent and child both painted");
  for (const cell of titles) await metaClick(cell);
  await r.settle();
  assert.match(r.text(), /2 selected/, "both rows are in the selection");

  // fold the parent: the child leaves the screen…
  await r.click(".db-tree-chevron");
  assert.equal(r.all("td.db-title").length, 1, "the child row is gone from the table");
  // …and stays in the selection, because a fold is not a deletion. The bar's
  // count is what the next ⌘⌫ would trash.
  assert.match(r.text(), /2 selected/, "the fold did not shrink the selection");

  // unfolding paints it back, still selected
  await r.click(".db-tree-chevron");
  assert.equal(r.all("tr.selected").length, 2, "both rows read as selected again");
});

test("a group header counts its section, not the slice a fold leaves painted", async (t) => {
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const r = await renderComponent(
    t,
    h(
      DatabasePane as never,
      paneProps({ pref: { view: "table", table_group_by: "Stage" } }) as never
    )
  );

  const count = () => r.one(".db-group-tr .db-group-count")?.textContent;
  assert.equal(count(), "2", "the section holds both notes");
  assert.match(r.text(), /2 rows/, "and so does the footer tally");

  await r.click(".db-tree-chevron");
  assert.equal(r.all("td.db-title").length, 1, "the fold took the child off the screen");
  assert.equal(count(), "2", "the header still counts the section it heads");
  assert.match(r.text(), /2 rows/, "the two counts on screen agree");
});
