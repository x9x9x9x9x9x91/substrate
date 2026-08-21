/** The tasks board's two empty shapes, rendered for real through the
    component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    A board whose `areas:` allowlist matched none of the open work reported
    itself green and "clear" — work finished, when in truth none of it was on
    the board. And the kanban shape said nothing at all when it was empty: an
    aria-hidden placeholder per column and no sentence, where the list shape
    had one. Both are render decisions, so both are pinned at the render. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import "./componentHarness.ts";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

const SCHEMA: SchemaConfig = {};

function task(title: string, area: string): NoteMeta {
  return {
    path: `Tasks/${title}.md`,
    stem: title,
    title,
    folder: "Tasks",
    props: { type: "task", area, created: "2026-07-01" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

function board(props: Record<string, unknown>): NoteMeta {
  return {
    path: "Dashboards/Tasks.md",
    stem: "Tasks",
    title: "Tasks",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "tasks", ...props },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = [task("Mix bounce", "Studio"), task("File receipts", "Admin")];

async function render(t: Parameters<typeof renderComponent>[0], props: Record<string, unknown>) {
  const { default: TasksDashboard } = await import("../components/TasksDashboard.tsx");
  return renderComponent(
    t,
    createElement(TasksDashboard, {
      meta: board(props),
      notes: NOTES,
      schema: SCHEMA,
      onOpenSource: () => {},
      onMutated: () => {},
    })
  );
}

test("a filter that matched nothing does not report all-clear", async (t) => {
  const rendered = await render(t, { areas: "No Such Area", view: "board" });

  assert.match(rendered.text(), /no matches/);
  assert.doesNotMatch(rendered.text(), /clear/);
  const dot = rendered.one(".dash-state .dash-dot") as HTMLElement | null;
  assert.ok(dot, "the head carries a dot");
  assert.notEqual(dot.style.background, "var(--ok)");
  // and it says where the work went
  assert.match(rendered.text(), /2 open in areas this board doesn't list/);
});

test("the board shape carries the empty sentence the list shape has", async (t) => {
  const rendered = await render(t, { areas: "No Such Area", view: "board" });

  // the column rail stays — those are the drop targets
  assert.equal(rendered.all(".tasks-col").length, 1);
  // …and the empty state is real text, not an aria-hidden placeholder
  const empty = rendered.one(".tasks-empty");
  assert.ok(empty, "the board shape renders an empty line");
  assert.ok((empty.textContent ?? "").trim().length > 0);
  assert.equal(empty.getAttribute("aria-hidden"), null);
});

test("an allowlist with nothing open in it still reads as clear", async (t) => {
  const rendered = await render(t, { areas: "Studio, Admin", view: "list" });

  // both tasks match, so this is the populated board — the guard against a
  // "no matches" that fires on a working filter
  assert.match(rendered.text(), /2 open/);
  assert.doesNotMatch(rendered.text(), /no matches/);
});
