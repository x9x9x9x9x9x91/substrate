/** A hub callout that asked for the wide card, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    The width is the whole feature, and it is spent entirely in a class name a
    stylesheet reads — the parse test one file over proves the token was read,
    not that the card ever wore it. So the render is pinned here: the wide
    card carries the span class, its neighbours do not, and a width the board
    can't honour leaves an ordinary card rather than a broken row. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

/* the hub reads its own note for callouts, so the fixture is a real note in
   the mock vault — a clone of a seeded hub, body replaced per test */
const BOARD = "Dashboards/Hub Span Fixture.md";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Dashboards/Umbra Home.md", BOARD);
});

after(() => {
  win.__mockDeleteNote(BOARD);
});

const meta: NoteMeta = {
  path: BOARD,
  stem: "Hub Span Fixture",
  title: "Hub Span Fixture",
  folder: "Dashboards",
  props: { type: "dashboard", dashboard: "hub" },
  updated_ms: 0,
  excerpt: "",
  sealed: false,
};

async function render(t: Parameters<typeof renderComponent>[0], body: string) {
  win.__mockEditNote(BOARD, body);
  const { default: HubDashboard } = await import("../components/HubDashboard.tsx");
  return renderComponent(
    t,
    createElement(HubDashboard, {
      meta,
      notes: [],
      schema: {},
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );
}

test("the callout that asked for two columns is the only wide card", async (t) => {
  const rendered = await render(
    t,
    "> [!note|span:2] Wide\n> the whole row\n> [!warn] Narrow\n> beside it\n"
  );

  const cards = rendered.all(".hub-card");
  assert.equal(cards.length, 2);
  assert.ok(cards[0].classList.contains("span-2"), "the wide card carries the span class");
  assert.equal(cards[1].classList.contains("span-2"), false, "its neighbour stays one column");
  // the card is still an ordinary callout card underneath — the width is the
  // only thing the token changed
  assert.ok(cards[0].classList.contains("hub-card-note"));
  assert.match(cards[0].textContent ?? "", /Wide/);
});

test("an accent and a width ride the same header without displacing each other", async (t) => {
  const rendered = await render(t, "> [!idea|teal|span:2] Both\n> body\n");

  const card = rendered.all(".hub-card")[0];
  assert.ok(card.classList.contains("span-2"));
  assert.equal(card.getAttribute("data-accent"), "teal");
});

test("a width the board can't honour leaves an ordinary card, not a broken row", async (t) => {
  const rendered = await render(t, "> [!note|span:7] Still a card\n> body\n");

  const card = rendered.all(".hub-card")[0];
  assert.equal(card.classList.contains("span-2"), false);
  assert.match(card.textContent ?? "", /Still a card/);
});
