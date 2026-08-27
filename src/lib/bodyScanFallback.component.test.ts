/** A keyless `type: dashboard` note, rendered for real through DashboardPane
    (harness pattern in `docs/component-tests.md`).

    The fallback used to anchor on chart, heatmap and calendar fences only: a
    note whose body carried nothing but a progress, timeline, view or cards
    fence reported "nothing configured" — a help card over a body that had
    plainly asked for a board the hub draws live. What is pinned here is the
    widened anchor (such a note gets the hub canvas), the unchanged precedence
    of the three dedicated boards, and the help card's fence list naming
    everything that would have rescued the note. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const BOARD = "Dashboards/Keyless Fixture.md";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Dashboards/Umbra Home.md", BOARD);
});

after(() => {
  win.__mockDeleteNote(BOARD);
});

/* no `dashboard:` key — the shape that reaches the body scan */
const keylessMeta: NoteMeta = {
  path: BOARD,
  stem: "Keyless Fixture",
  title: "Keyless Fixture",
  folder: "Dashboards",
  props: { type: "dashboard" },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

async function pane(t: Parameters<typeof renderComponent>[0], body: string) {
  win.__mockEditNote(BOARD, body);
  const { default: DashboardPane } = await import("../components/DashboardPane.tsx");
  return renderComponent(
    t,
    h(DashboardPane, {
      meta: keylessMeta,
      notes: [keylessMeta],
      vaultEpoch: 0,
      schema: {},
      onOpenSource: () => {},
      onMutated: () => {},
    })
  );
}

test("a keyless note carrying only a progress fence draws a board, not the help card", async (t) => {
  const rendered = await pane(t, "My goal.\n\n```progress\ntarget: 10\n```\n");

  assert.ok(rendered.one(".hub-body"), "the hub canvas mounted");
  assert.ok(rendered.one(".hub-progress"), "the goal thermometer drew");
  assert.doesNotMatch(rendered.text(), /nothing to render yet/);
});

test("a keyless note carrying only a timeline fence reaches the hub, not the help card", async (t) => {
  const rendered = await pane(t, "```timeline\nsource: Session\n```\n");

  assert.ok(rendered.one(".hub-body"), "the hub canvas mounted");
  assert.doesNotMatch(rendered.text(), /nothing to render yet/);
});

test("a keyless note carrying only a view embed reaches the hub, not the help card", async (t) => {
  const rendered = await pane(t, "```view\ntype: Session\n```\n");

  assert.ok(rendered.one(".hub-body"), "the hub canvas mounted");
  assert.doesNotMatch(rendered.text(), /nothing to render yet/);
});

test("a chart fence still takes the charts board — the widened anchor changed no precedence", async (t) => {
  const rendered = await pane(
    t,
    "```chart\ntype: Session\n```\n\n```progress\ntarget: 10\n```\n"
  );

  assert.equal(rendered.all(".hub-body").length, 0, "the dedicated board won, not the hub");
  assert.match(rendered.text(), /Chart block|chart/i);
});

test("a fence-free body still gets the help card, and the card names every fence that would rescue it", async (t) => {
  const rendered = await pane(t, "Just prose, no fences at all.\n");

  assert.match(rendered.text(), /nothing configured/);
  assert.match(rendered.text(), /view, chart, progress, cards, heatmap, calendar or timeline fence/);
});
