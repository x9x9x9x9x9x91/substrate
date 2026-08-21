/** The yield board's two state-truth paths, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    Both were invisible before: a read that failed drew the same board a note
    with no snapshots draws — byte-identical shots — and a correctly
    configured board with nothing logged yet flew the red dot the board flies
    when something is actually wrong. Neither could be told from the outside,
    which is why both are pinned here rather than in a shot. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const SEEDED = "Dashboards/Yield APR.md";
const EMPTY = "Dashboards/Yield Empty.md";

function board(path: string, title: string): NoteMeta {
  return {
    path,
    stem: title,
    title,
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "yield-apr" },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  /* A board configured exactly like the seeded one and simply never logged
     into: the empty-but-healthy case, which is not the same note as one that
     cannot be read. */
  win.__mockCloneNote(SEEDED, EMPTY);
  win.__mockEditNote(EMPTY, "Nothing logged yet.\n\n```csv\nat,yield_usd,principal_usd\n```\n");
});

after(() => {
  win.__mockDeleteNote(EMPTY);
  win.__mockFail?.delete("vault_read");
});

test("a note it cannot read says so instead of drawing an empty board", async (t) => {
  win.__mockFail = new Set(["vault_read"]);
  const { default: YieldDashboard } = await import("../components/YieldDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(YieldDashboard, {
      meta: board(SEEDED, "Yield APR"),
      vaultEpoch: 0,
      onOpenSource: () => {},
      onMutated: () => {},
    })
  );
  win.__mockFail.delete("vault_read");

  assert.match(rendered.text(), /could not be read/);
  // and it does NOT tell a reader whose file is unreadable to log snapshots
  assert.doesNotMatch(rendered.text(), /Needs two snapshots/);
});

test("an empty board flies no danger dot", async (t) => {
  const { default: YieldDashboard } = await import("../components/YieldDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(YieldDashboard, {
      meta: board(EMPTY, "Yield Empty"),
      vaultEpoch: 0,
      onOpenSource: () => {},
      onMutated: () => {},
    })
  );

  assert.match(rendered.text(), /Needs two snapshots/);
  assert.doesNotMatch(rendered.text(), /could not be read/);
  const dot = rendered.one(".dash-state .dash-dot") as HTMLElement | null;
  assert.ok(dot, "the head still carries a state dot");
  assert.equal(dot.style.background, "var(--text-3)");
});
