/** A heatmap fence that is still being written, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    Typing `/heatmap` inserts the fence's required keys with nothing after
    them, and the pane used to answer that with a red parse-error banner over
    the reader's own untouched scaffold — "can't parse line: source:". A fence
    mid-writing is not a broken one, so it gets the calm state and the words
    that say what it is waiting for. The banner is pinned to stay put for
    config that is actually wrong. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

/** the note the scaffold lands in: no `dashboard:` prop, one heatmap fence */
function board(): NoteMeta {
  return {
    path: "Dashboards/Year.md",
    stem: "Year",
    title: "Year",
    folder: "Dashboards",
    props: {},
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const SCHEMA: SchemaConfig = {};

// the pane reads sheets and the number dial through the backend seam; neither
// body here names a sheet, but the surface still boots against a real mock
before(async () => {
  await mockBackend();
});

async function pane(t: Parameters<typeof renderComponent>[0], body: string) {
  const { default: HeatmapDashboard } = await import("../components/HeatmapDashboard.tsx");
  return renderComponent(
    t,
    createElement(HeatmapDashboard, {
      meta: board(),
      notes: [],
      body,
      vaultEpoch: 0,
      schema: SCHEMA,
      onOpenSource: () => {},
    })
  );
}

test("the untouched /heatmap scaffold teaches instead of erroring", async (t) => {
  const rendered = await pane(t, "```heatmap\nsource: \ndate: \nvalue: count\n```");

  // the calm dialect, not the banner
  assert.equal(rendered.all(".dash-alert").length, 0);
  assert.equal(rendered.all(".dash-empty").length, 1);
  const text = rendered.text();
  assert.match(text, /not filled in yet/);
  // and it names what each blank key takes, in the fence's own words
  assert.match(text, /source: a database type, or \{\{Sheet Name\}\} for a sheet/);
  assert.match(text, /the date property the squares sit on/);
  // `value: count` is answered, so it is not re-explained
  assert.doesNotMatch(text, /sum:<number prop>/);
  assert.doesNotMatch(text, /can't parse line/);
});

test("config that is wrong still gets the error banner", async (t) => {
  const rendered = await pane(t, "```heatmap\nsource: s\ndate: d\nvalue: count\nkind: bar\n```");

  assert.equal(rendered.all(".dash-empty").length, 0);
  assert.match(rendered.text(), /unknown key "kind"/);
});
