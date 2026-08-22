/** What a board hosting heatmaps calls itself, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    A note that says `dashboard: charts` and writes ```heatmap fences renders
    its heatmaps — the named kind must not silently drop a fence the keyless
    body scan would draw. What it also did was head itself "0 charts", print
    "No charts yet — add a ```chart fence to this note." over a page of
    rendered squares, and foot the page with a sentence about chart fences.
    Three places naming the wrong thing on a board that was neither empty nor
    a chart board. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import "./componentHarness.ts";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

const SCHEMA: SchemaConfig = {};
const NOTES: NoteMeta[] = [];

function board(): NoteMeta {
  return {
    path: "Dashboards/Board.md",
    stem: "Board",
    title: "Board",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "charts" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

async function charts(
  t: Parameters<typeof renderComponent>[0],
  body: string,
  afterHeatmaps: number
) {
  const { default: ChartsDashboard } = await import("../components/ChartsDashboard.tsx");
  return renderComponent(
    t,
    createElement(ChartsDashboard, {
      meta: board(),
      notes: NOTES,
      body,
      vaultEpoch: 0,
      schema: SCHEMA,
      onOpenSource: () => {},
      // the pane hands both together: the rendered heatmap sections and how
      // many of them there are
      after: afterHeatmaps > 0 ? createElement("div", { className: "heatmap-stand-in" }) : undefined,
      afterHeatmaps,
    })
  );
}

test("a charts-keyed board whose fences are heatmaps counts and names heatmaps", async (t) => {
  const rendered = await charts(t, "", 2);

  assert.equal(rendered.one(".dash-state")?.textContent, "2 heatmaps");
  // the body is a page of squares — telling its author to add a chart fence
  // names the wrong thing twice
  assert.equal(rendered.one(".dash-empty"), null);
  assert.match(rendered.text(), /Heatmaps are heatmap fences in this note/);
  assert.doesNotMatch(rendered.text(), /No charts yet/);
});

test("one heatmap is a heatmap", async (t) => {
  const rendered = await charts(t, "", 1);
  assert.equal(rendered.one(".dash-state")?.textContent, "1 heatmap");
});

test("a board with neither still asks for the fence its kind is named for", async (t) => {
  const rendered = await charts(t, "", 0);

  assert.equal(rendered.one(".dash-state")?.textContent, "0 charts");
  assert.match(rendered.text(), /No charts yet/);
  assert.match(rendered.text(), /Charts are chart fences in this note/);
});

test("a board carrying both counts both, charts first", async (t) => {
  const fence =
    "```chart\n" + "source: release\nx: released:month\ny: count\n" + "```\n";
  const rendered = await charts(t, fence, 3);

  assert.equal(rendered.one(".dash-state")?.textContent, "1 chart · 3 heatmaps");
  // it is a chart board that also hangs heatmaps, so the foot stays the
  // charts sentence
  assert.match(rendered.text(), /Charts are chart fences in this note/);
});
