/** `ctx.fx` — what a vault-resident kind may know about exchange rates.
 *
 *  Two halves, and the second is the one that matters. The shape is cheap to
 *  pin and mostly pinned already by the compile-time contract in
 *  `CustomKindPane` (`KindContractPinned`). What no type can state is the
 *  promise the member rests on: a kind gets rates through the app's one
 *  gated call and never opens its own, so `net-fx-rates: false` has to stay
 *  a single switch now that vault code can reach for a refresh. That is
 *  asserted here the way the e2e privacy specs assert it — by counting the
 *  `fx_rates` command at the mock seam, not by trusting the call graph.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mockBackend } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import { MOCK_FX_RATES, usdEurFrom, type FxRatesState } from "./fx.ts";
import { fxRedrawNeeded, kindFx } from "./kindfx.ts";

let win: MockWindow;
before(async () => {
  win = await mockBackend();
});

const TABLE: FxRatesState = { base: "EUR", rates: { USD: 1.2, GBP: 0.8 }, asOf: "2026-08-20", live: true };

test("ctx.fx hands over the table, the failure and a resolver for any pair", () => {
  const fx = kindFx(TABLE, null, () => {});
  assert.deepEqual(fx.table, TABLE);
  assert.equal(fx.err, null);
  assert.equal(typeof fx.refresh, "function");
  // the base's own rate is 1 and is not in the table — indexing `rates` would
  // read undefined, which is why the pair goes through `rate()`
  assert.equal(fx.rate("EUR", "EUR"), 1);
  assert.equal(fx.rate("USD", "EUR"), 1 / 1.2);
  assert.equal(fx.rate("usd", "gbp"), 0.8 / 1.2);
  // an unquoted code is null, never a wrong figure
  assert.equal(fx.rate("USD", "ZWL"), null);
});

test("the USD→EUR pair reads the same through ctx.fx as through the app's own hook", () => {
  const pair = usdEurFrom(MOCK_FX_RATES);
  assert.notEqual(pair, null);
  assert.equal(kindFx(MOCK_FX_RATES, null, () => {}).rate("USD", "EUR"), pair?.usdEur);
});

test("the table is a copy — vault code cannot reprice the app through it", () => {
  const live: FxRatesState = { base: "EUR", rates: { USD: 1.2 }, asOf: "2026-08-20", live: true };
  const handed = kindFx(live, null, () => {}).table;
  assert.notEqual(handed, null);
  handed!.rates.USD = 1;
  handed!.asOf = "1999-01-01";
  assert.equal(live.rates.USD, 1.2);
  assert.equal(live.asOf, "2026-08-20");
});

test("before any load landed there is no table and no rate, rather than a zero", () => {
  const fx = kindFx(null, "frankfurter.dev did not answer", () => {});
  assert.equal(fx.table, null);
  assert.equal(fx.rate("USD", "EUR"), null);
  assert.equal(fx.err, "frankfurter.dev did not answer");
});

test("fresh rates are a redraw signal, an unchanged refresh is not (SUB-1451)", () => {
  // `ctx.fx` is a getter, so the new table is readable the moment it lands —
  // but a mounted kind only looks when `ctx.onChange` fires, and nothing fired
  // for rates. `ctx.fx.refresh()` therefore resolved to a board that kept
  // showing the figures it drew at mount until an unrelated note changed.
  const before = { table: TABLE, err: null };
  assert.equal(fxRedrawNeeded(before, before), false, "the same read twice is not news");
  assert.equal(fxRedrawNeeded({ table: null, err: null }, before), true, "the first table to land");
  // A new object with the same numbers IS a redraw: the store only hands one
  // out when a load landed, and comparing fields would need a deep walk to
  // save a draw nobody would notice.
  assert.equal(fxRedrawNeeded(before, { table: { ...TABLE }, err: null }), true);
  // The failure line counts — "no rate" becoming "the request failed" is a
  // sentence a board owes its reader.
  assert.equal(fxRedrawNeeded(before, { table: TABLE, err: "frankfurter.dev did not answer" }), true);
});

/* The gate. `ctx.fx.refresh` is `useFx`'s own forced refresh — the point of
   routing it there rather than giving kinds a fetch — so exercising that
   function is exercising exactly what a kind can reach. */

const traced = () =>
  (win.__mockReadCommandTrace?.() ?? []) as { cmd?: string; path?: string; doneMs?: number }[];

const fxCalls = () => traced().filter((e) => e.cmd === "fx_rates").length;

/** Wait for the settings read the refresh opens with to come back, then let
    its continuation run — the point where a fetch would have been issued. */
async function settleRefresh() {
  for (let i = 0; i < 200; i++) {
    if (traced().some((e) => e.cmd === "vault_read" && e.path === "Settings.md" && e.doneMs !== undefined)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 50));
}

test("net-fx-rates off: a kind asking for a refresh fetches nothing", async () => {
  const { refreshFxRates } = await import("../components/useFx.ts");
  win.__mockEditProp("Settings.md", "net-fx-rates", "false");
  win.__mockTraceCommands?.();

  kindFx(null, null, refreshFxRates).refresh();
  await settleRefresh();

  assert.equal(fxCalls(), 0);
});

test("net-fx-rates on: the same call reaches the app's one FX request", async () => {
  const { refreshFxRates } = await import("../components/useFx.ts");
  win.__mockEditProp("Settings.md", "net-fx-rates", null);
  win.__mockTraceCommands?.();

  kindFx(null, null, refreshFxRates).refresh();
  await settleRefresh();

  assert.equal(fxCalls(), 1);
});
