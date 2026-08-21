/** A `view` fence that matched nothing, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    The fence-config matrix caught this by writing a query with a keyword that
    isn't one — the way a reader will hit it. The table painted its header row
    and stopped: no rows, no error, no empty state, which reads as a broken
    dashboard rather than an empty cut. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import "./componentHarness.ts";
import { renderComponent } from "./componentHarness.ts";
import type { EmbedResult } from "./embeds.ts";

type Resolved = Extract<EmbedResult, { columns: string[] }>;

const EMPTY: Resolved = {
  dbType: "release",
  columns: ["status", "label"],
  rows: [],
  total: 0,
  typeSchema: {},
  query: "key:nothing",
};

const POPULATED: Resolved = {
  ...EMPTY,
  rows: [{ path: "Releases/One.md", title: "One", props: {}, cells: ["live", "Northline"], updated_ms: 0 }],
  total: 1,
};

async function render(t: Parameters<typeof renderComponent>[0], result: Resolved) {
  const { default: EmbedViewTable } = await import("../components/EmbedViewTable.tsx");
  return renderComponent(t, createElement(EmbedViewTable, { result, onOpenSource: () => {} }));
}

test("a zero-match cut says so instead of painting a bare header", async (t) => {
  const rendered = await render(t, EMPTY);

  assert.equal(rendered.all("tbody tr").length, 0);
  assert.match(rendered.text(), /No rows matched — check the query and property names\./);
});

test("a cut that matched keeps the table to itself", async (t) => {
  const rendered = await render(t, POPULATED);

  assert.equal(rendered.all("tbody tr").length, 1);
  assert.doesNotMatch(rendered.text(), /No rows matched/);
});
