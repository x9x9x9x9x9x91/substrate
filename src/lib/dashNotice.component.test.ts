/** The two sentences a dashboard kind falls back to when it has nothing to
    draw, rendered for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    Fifteen kinds used to hand-assemble these, which is how four dialects of
    "nothing here" and six near-identical error classes got into one product.
    The dress lives in one place now, so it is worth pinning what that dress
    IS — a reader can tell the calm state from the failed one at a glance, and
    the failed one is never mistaken for a footer. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import "./componentHarness.ts";
import { renderComponent } from "./componentHarness.ts";

async function notice() {
  return import("../components/DashNotice.tsx");
}

/** `one` hands back a nullable — every lookup here is load-bearing, so a miss
    is the assertion failing rather than a null flowing into the next line. */
function must(el: Element | null, what: string): Element {
  assert.ok(el, `expected ${what} to render`);
  return el;
}

test("an empty state is a dot and its sentence, in the house voice", async (t) => {
  const { DashEmpty } = await notice();
  const rendered = await renderComponent(
    t,
    createElement(DashEmpty, null, "No tiles yet — add a tile fence to this note.")
  );

  const box = must(rendered.one(".dash-empty"), "the empty state");
  assert.match(box.textContent ?? "", /No tiles yet/);
  // the mark is structural: a kind cannot ship an empty state without one,
  // which is what the faint one-line footers were missing
  assert.equal(box.querySelectorAll(".dash-dot").length, 1);
});

test("the calm state is quiet by default and green only when emptiness is the good news", async (t) => {
  const { DashEmpty } = await notice();

  const quiet = await renderComponent(t, createElement(DashEmpty, null, "Nothing queued."));
  assert.match(must(quiet.one(".dash-dot"), "the quiet dot").getAttribute("style") ?? "", /--text-4/);

  const clear = await renderComponent(
    t,
    createElement(DashEmpty, { tone: "ok" as const, children: "Everything accounted for." })
  );
  assert.match(must(clear.one(".dash-dot"), "the all-clear dot").getAttribute("style") ?? "", /--ok/);
});

test("a failure is the banner, and carries no dot to be mistaken for a state", async (t) => {
  const { DashAlert } = await notice();
  const rendered = await renderComponent(
    t,
    createElement(DashAlert, null, "launchd unreadable — the scheduler could not be read.")
  );

  const box = must(rendered.one(".dash-alert"), "the banner");
  assert.match(box.textContent ?? "", /launchd unreadable/);
  assert.equal(box.querySelectorAll(".dash-dot").length, 0);
  assert.equal(rendered.all(".dash-empty").length, 0);
});

test("a failure that arrives announces itself; one painted with the board does not", async (t) => {
  const { DashAlert } = await notice();

  // a board's banner is met by reading — announcing it would talk over the
  // reader arriving at the board
  const painted = await renderComponent(t, createElement(DashAlert, null, "broken fence"));
  assert.equal(must(painted.one(".dash-alert"), "the banner").getAttribute("role"), null);

  // a sync that failed answers a button pressed a second ago, and the reader
  // may be nowhere near it
  const arrived = await renderComponent(
    t,
    createElement(DashAlert, { live: true, children: "push rejected" })
  );
  assert.equal(must(arrived.one(".dash-alert"), "the live banner").getAttribute("role"), "alert");
});

test("a tile's failure asks to hold its cell open", async (t) => {
  const { DashAlert } = await notice();

  const flow = await renderComponent(t, createElement(DashAlert, null, "broken"));
  assert.equal(must(flow.one(".dash-alert"), "the banner").className, "dash-alert");

  const tile = await renderComponent(t, createElement(DashAlert, { fill: true, children: "broken" }));
  // the grid row would otherwise collapse around the failure and reflow the
  // tiles that rendered fine
  assert.equal(must(tile.one(".dash-alert"), "the tile banner").className, "dash-alert is-fill");
});
