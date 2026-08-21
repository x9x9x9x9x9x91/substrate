/** What a chart or heatmap fence says when its `source:` names a database
    that does not exist, rendered for real through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A `view` fence has always answered "Unknown database" in red; the chart
    and heatmap fences had no existence check at all, so a misspelled type
    drew the neutral zero-match line — a typo reading as an empty database, on
    the same board where the fence below it names the same mistake. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import "./componentHarness.ts";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

const SCHEMA: SchemaConfig = {};

function note(title: string, type: string): NoteMeta {
  return {
    path: `${type}/${title}.md`,
    stem: title,
    title,
    folder: type,
    props: { type, status: "live" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [note("One", "release"), note("Two", "release")];

function board(): NoteMeta {
  return {
    path: "Dashboards/Charts Fixture.md",
    stem: "Charts Fixture",
    title: "Charts Fixture",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "charts" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const fence = (lang: string, inner: string) => "```" + lang + "\n" + inner + "\n```\n";

async function charts(t: Parameters<typeof renderComponent>[0], body: string) {
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
    })
  );
}

test("a chart source that is not a database is named, not drawn empty", async (t) => {
  const rendered = await charts(t, fence("chart", "source: nosuchdb\nx: status\ny: count"));

  assert.match(rendered.text(), /Unknown database “nosuchdb”/);
  assert.doesNotMatch(rendered.text(), /No rows matched/);
});

test("a real database with no matching rows keeps the zero-match line", async (t) => {
  // the guard: an existence check that fires on real-but-empty cuts would
  // turn every honest empty plot into an accusation
  const rendered = await charts(
    t,
    fence("chart", "source: release\nx: status\ny: count\nquery: status:archived")
  );

  assert.doesNotMatch(rendered.text(), /Unknown database/);
});

test("a heatmap source that is not a database is named too", async (t) => {
  const { default: HeatmapDashboard } = await import("../components/HeatmapDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(HeatmapDashboard, {
      meta: board(),
      notes: NOTES,
      body: fence("heatmap", "source: nosuchdb\ndate: released\nvalue: count"),
      vaultEpoch: 0,
      schema: SCHEMA,
      onOpenSource: () => {},
    })
  );

  assert.match(rendered.text(), /Unknown database “nosuchdb”/);
});
