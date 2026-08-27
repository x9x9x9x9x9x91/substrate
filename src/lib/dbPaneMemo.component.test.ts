/** Proof that `memo(DatabasePane)` is not a no-op.
 *
 *  A memo boundary on a pane whose props churn every render changes nothing
 *  and reports nothing — the diff looks like a win and the pane keeps
 *  re-rendering. So the boundary is pinned by counting: render the pane
 *  through `DbPaneStack` the way App does, change a piece of state the pane
 *  does not read, and assert the render count did not move.
 *
 *  The counter is `renderProbe.ts` — opt-in, installed here, uninstalled
 *  after. `DatabasePane` bumps it once per render of its body.
 *
 *  The control assertion matters as much as the memo one: the button below
 *  renders its own tick, so the test can tell "the pane didn't re-render"
 *  apart from "nothing re-rendered at all", which would pass vacuously.
 *
 *  What this does NOT prove: that App's own `dbPaneCtx` keeps identity across
 *  every state change in the real App — that depends on the ~24 App-level
 *  callbacks it closes over, several of which live in hooks this test does not
 *  mount. It proves the stack + memo half of the chain: given a stable ctx,
 *  the pane is insulated. */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement as h, useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { renderComponent } from "./componentHarness.ts";
import { clearRenderProbe, installRenderProbe } from "./renderProbe.ts";
import type { NoteMeta } from "./types.ts";

const NOTES: NoteMeta[] = [
  {
    path: "Row 001.md",
    stem: "Row 001",
    title: "Row 001",
    folder: "",
    props: { Type: "Release" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  },
];

const NOOP = () => {};
/* hoisted on purpose: an inline `{ view: "table" }` here would be a fresh
   object per render of the wrapper and would defeat the memo all by itself —
   the same trap the App-side call sites carry, and what the stack exists to
   keep out of them. */
const PREF = { view: "table" } as const;

after(() => clearRenderProbe());

/** App in miniature: one unrelated state cell, one memoized ctx, one stack. */
function Harness() {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  // the same shape App builds — every member a stable identity, so the object
  // survives the unrelated state change below
  const ctx = useMemo(
    () => ({
      allNotes: NOTES,
      schema: { Release: {} },
      savedViews: [],
      dbIcons: {},
      dbTypes: ["Release"],
      relationCandidates: () => [],
      pinKeys: {},
      gridDefault: false,
      onCreateEntry: () => Promise.reject(new Error("not used")),
      onMutated: NOOP,
      onToast: NOOP,
      onSaveIcon: NOOP,
      usedValues: () => [],
      onSaveSchema: NOOP,
      onPromoteOption: NOOP,
      onSaveView: NOOP,
      onOpenView: NOOP,
      onViewMenu: NOOP,
      onRenameDb: NOOP,
      onDeleteDb: NOOP,
      onRenameProp: NOOP,
      onRemoveProp: NOOP,
      onSetParentProp: NOOP,
    }),
    []
  );
  return h(
    "div",
    null,
    h("button", { type: "button", className: "bump", onClick: bump }, `tick ${tick}`),
    h(HarnessPane, { ctx })
  );
}

/** Filled in by the test once the dynamic import has run — the stack has to be
    imported after the harness installs the DOM globals. */
let HarnessPane: (props: { ctx: unknown }) => ReactElement;

test("an unrelated App state change does not re-render DatabasePane", async (t) => {
  const { default: DbPaneStack } = await import("../components/DbPaneStack.tsx");
  HarnessPane = ({ ctx }: { ctx: unknown }) =>
    h(DbPaneStack, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: ctx as any,
      dbType: "Release",
      notes: NOTES,
      pref: PREF,
      openPath: null,
      newSignal: 0,
      onPrefChange: NOOP,
      onOpenNote: NOOP,
      onNoteMenu: NOOP,
      onTrashNotes: NOOP,
    });

  const probe = installRenderProbe();
  const r = await renderComponent(t, h(Harness));
  await r.settle();

  const before = probe.DatabasePane ?? 0;
  assert.ok(before > 0, "the pane rendered at least once");
  assert.match(r.text(), /tick 0/);

  await r.click(".bump");
  await r.settle();

  assert.match(r.text(), /tick 1/, "the unrelated state actually changed");
  assert.equal(
    probe.DatabasePane ?? 0,
    before,
    "memo(DatabasePane) held — no re-render from state the pane does not read"
  );
});
