/** What a metric card says when its binding or its format is wrong, rendered
    for real through the component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    Both cases were quiet in different ways. A bad PROPERTY name already
    failed loudly, while a bad SHEET name rendered a bare "—" with the reason
    buried in a hover title — indistinguishable, on a dashboard, from a value
    that is legitimately empty. And a `format:` the app doesn't have was
    refused inside a ```cards fence but silently accepted in frontmatter,
    where it rendered an unformatted number that looks like a working card. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { parseCards } from "./metriccards.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

/* the board reads its own note for fences, so the fixture is a real note in
   the mock vault — a clone of a seeded metrics board, cards replaced */
const BOARD = "Dashboards/Metrics Fixture.md";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  win.__mockCloneNote("Dashboards/Portfolio.md", BOARD);
});

after(() => {
  win.__mockDeleteNote(BOARD);
  win.__mockFail?.delete("vault_read");
});

function board(cards: unknown[]): NoteMeta {
  return {
    path: BOARD,
    stem: "Metrics Fixture",
    title: "Metrics Fixture",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "metrics", cards },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

async function render(t: Parameters<typeof renderComponent>[0], cards: unknown[]) {
  const { default: MetricsDashboard } = await import("../components/MetricsDashboard.tsx");
  return renderComponent(
    t,
    createElement(MetricsDashboard, {
      meta: board(cards),
      notes: [],
      schema: {},
      vaultEpoch: 0,
      onOpenSource: () => {},
      onMutated: () => {},
    })
  );
}

test("a bind to a sheet that isn't there names the miss on the card", async (t) => {
  const rendered = await render(t, [
    { label: "Nowhere", bind: "{{Nowhere.total}}", format: "eur" },
    { label: "Holdings", bind: "{{Holdings.positions}}", format: "number" },
  ]);

  const misses = rendered.all(".dash-card-miss").map((el) => el.textContent);
  assert.equal(misses.length, 1, "exactly the broken card carries a reason line");
  assert.match(misses[0] ?? "", /no note named “Nowhere”/);
});

test("frontmatter names an unknown format instead of formatting silently", () => {
  // the parse half, where the two authoring surfaces used to diverge: the
  // fence throws on this value, frontmatter took it and said nothing
  const [bad, good] = parseCards({
    cards: [
      { label: "Total", bind: "{{Holdings.total}}", format: "furlongs" },
      { label: "Units", bind: "{{Holdings.positions}}", format: "EUR" },
    ],
  });
  assert.match(bad.formatErr ?? "", /unknown format "furlongs" — want eur, usd, number, pct/);
  // a known format still parses, case-folded, with nothing to report
  assert.equal(good.format, "eur");
  assert.equal(good.formatErr, undefined);
});

test("an unknown format reads as a miss on the rendered card", async (t) => {
  const rendered = await render(t, [
    { label: "Total", bind: "{{Holdings.total}}", format: "furlongs" },
  ]);

  assert.match(rendered.text(), /unknown format "furlongs"/);
  // the number is still shown — a bad format is not a reason to withhold it
  const value = rendered.one(".dash-card-eur");
  assert.match(value?.textContent ?? "", /\d/);
});

test("a format the author capitalised still formats", async (t) => {
  // the roster check folds case, so a `format: EUR` that reached the
  // formatter uncased would render a bare number with nothing said about it —
  // known to the check, unknown to the renderer, silent to the reader
  const rendered = await render(t, [
    { label: "Total", bind: "{{Holdings.total}}", format: "EUR" },
  ]);

  assert.doesNotMatch(rendered.text(), /unknown format/);
  const value = rendered.one(".dash-card-eur");
  assert.match(value?.textContent ?? "", /[€$]|EUR/);
});

test("a sheet the vault refuses to read names the failure, not the Error class", async () => {
  // the caught-exception path behind a card's miss line: whatever the read
  // threw IS the reader's whole account of what went wrong, so it may not
  // arrive with "Error:" in front of it
  const { dashboardSheets } = await import("./dashboardSheets.ts");
  win.__mockFail = new Set(["vault_read"]);
  // a fresh epoch: the loader shares one promise per (names, epoch, rates)
  const sheets = await dashboardSheets(["Holdings"], 4271, null);
  win.__mockFail.delete("vault_read");

  const state = sheets.get("holdings");
  assert.ok(state && "error" in state, "the unreadable sheet is an error state");
  assert.equal(state.error, "mock failure: vault_read");
  assert.doesNotMatch(state.error, /Error:/);
});
