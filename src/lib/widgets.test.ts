import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { NoteMeta } from "./types.ts";

/** `widgets.ts` imports the IPC layer, which reads `window` while evaluating —
    so the DOM globals go up first and the module arrives via dynamic import,
    the componentHarness idiom. */
let widgets: typeof import("./widgets.ts");
before(async () => {
  await import("./componentHarness.ts");
  widgets = await import("./widgets.ts");
});

const note = (path: string, title: string, props: Record<string, unknown>): NoteMeta => ({
  path,
  stem: path.replace(/\.md$/, ""),
  title,
  folder: "",
  props,
  updated_ms: 0,
  excerpt: "",
  sealed: false,
});

const card = (label: string, bind: string) => ({ label, bind });

const board = note("Dashboards/Money.md", "Money", {
  type: "dashboard",
  dashboard: "metrics",
  cards: [card("Net worth", "{{Holdings.total}}"), card("Cash", "{{Holdings.cash}}")],
});
const other = note("Notes/Plain.md", "Plain", { type: "note" });

test("index lists every card by name; nothing is evaluated with no widgets placed", async () => {
  let evaluations = 0;
  const summary = await widgets.buildWidgetSummary([board, other], [], async (cards) => {
    evaluations += cards.length;
    return cards.map(() => ({ text: "LEAK" }));
  });
  assert.equal(summary.schema, 2);
  assert.deepEqual(
    summary.index.map((entry) => entry.id),
    ["Dashboards/Money.md#0", "Dashboards/Money.md#1"],
  );
  assert.deepEqual(
    summary.index.map((entry) => entry.label),
    ["Net worth", "Cash"],
  );
  // the allow-list is empty, so no card is evaluated and no value is written
  assert.equal(evaluations, 0);
  assert.deepEqual(summary.cards, []);
  assert.ok(!JSON.stringify(summary).includes("LEAK"));
});

test("a placed widget's card — and only that card — gets its value exported", async () => {
  const summary = await widgets.buildWidgetSummary(
    [board],
    ["Dashboards/Money.md#1"],
    async (cards) => cards.map((c) => ({ text: `value:${c.label}` })),
  );
  assert.deepEqual(summary.cards, [{ id: "Dashboards/Money.md#1", value: "value:Cash" }]);
});

test("a miss travels as detail; unknown configured ids are ignored", async () => {
  const summary = await widgets.buildWidgetSummary(
    [board],
    ["Dashboards/Money.md#0", "Dashboards/Gone.md#4"],
    async (cards) => cards.map(() => ({ text: "—", miss: "no summary “total” on Holdings" })),
  );
  assert.deepEqual(summary.cards, [
    { id: "Dashboards/Money.md#0", value: "—", detail: "no summary “total” on Holdings" },
  ]);
});

test("a sealed dashboard never reaches the index, even configured", async () => {
  const sealedBoard = {
    ...note("Private/Sealed.md", "Sealed", {
      type: "dashboard",
      dashboard: "metrics",
      cards: [card("Secret", "{{Hidden.total}}")],
    }),
    sealed: true,
  };
  const summary = await widgets.buildWidgetSummary(
    [sealedBoard, board],
    ["Private/Sealed.md#0"],
    async (cards) => cards.map(() => ({ text: "LEAK" })),
  );
  assert.deepEqual(
    summary.index.map((entry) => entry.dashboardPath),
    ["Dashboards/Money.md", "Dashboards/Money.md"],
  );
  assert.ok(!JSON.stringify(summary).includes("Sealed"));
  assert.ok(!JSON.stringify(summary).includes("LEAK"));
});

test("non-metrics notes contribute nothing to the index", async () => {
  const hub = note("Dashboards/Hub.md", "Hub", { type: "dashboard", dashboard: "hub" });
  const summary = await widgets.buildWidgetSummary([other, hub], [], async () => []);
  assert.deepEqual(summary.index, []);
});
