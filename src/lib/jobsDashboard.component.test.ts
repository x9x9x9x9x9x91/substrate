/** The jobs board's head and its empty sentence, rendered for real through
    the component harness (`componentHarness.ts`, pattern in
    `docs/component-tests.md`).

    Three things the audit caught by eye and nothing pinned: an empty board
    was the one head in the set that dropped its state dot, the empty
    sentence printed two full stops because launchd labels carry their own
    trailing one, and a failed read put a caught Error's class name into the
    sentence a reader is meant to act on. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

/** No machine schedules anything under this — the empty board, reached the
    way an author reaches it: by naming prefixes of their own. */
const NOTHING = "com.nothing.here.";

function board(props: Record<string, unknown> = {}): NoteMeta {
  return {
    path: "Dashboards/Jobs.md",
    stem: "Jobs",
    title: "Jobs",
    folder: "Dashboards",
    props: { type: "dashboard", dashboard: "jobs", ...props },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

let win: MockWindow;

before(async () => {
  win = await mockBackend();
});

after(() => {
  win.__mockFail?.delete("jobs_read");
});

test("an empty board keeps its state dot and ends its sentence once", async (t) => {
  const { default: JobsDashboard } = await import("../components/JobsDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(JobsDashboard, {
      meta: board({ prefixes: NOTHING }),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );

  assert.match(rendered.text(), /no jobs here/);
  const dot = rendered.one(".dash-state .dash-dot") as HTMLElement | null;
  assert.ok(dot, "the empty head still carries a dot");
  assert.equal(dot.style.background, "var(--text-3)");
  assert.match(rendered.text(), /under com\.nothing\.here\./);
  assert.doesNotMatch(rendered.text(), /\.\./);
});

test("a failed read names the failure without its class name", async (t) => {
  win.__mockFail = new Set(["jobs_read"]);
  const { default: JobsDashboard } = await import("../components/JobsDashboard.tsx");
  const rendered = await renderComponent(
    t,
    createElement(JobsDashboard, {
      meta: board(),
      vaultEpoch: 0,
      onOpenSource: () => {},
    })
  );
  win.__mockFail.delete("jobs_read");

  assert.match(rendered.text(), /launchd unreadable — mock failure: jobs_read/);
  assert.doesNotMatch(rendered.text(), /Error:/);
});

test("the arriving board wears the loading dialect, not the empty one", async (t) => {
  // three states, three voices: the settled-empty dot-and-sentence must not
  // stand in for "still reading", which reads as "you have no jobs" over a
  // board that is one IPC away from a full table
  win.__mockHoldCommand?.("jobs_read");
  try {
    const { default: JobsDashboard } = await import("../components/JobsDashboard.tsx");
    const rendered = await renderComponent(
      t,
      createElement(JobsDashboard, {
        meta: board(),
        vaultEpoch: 0,
        onOpenSource: () => {},
      })
    );
    assert.match(rendered.text(), /reading launchd…/);
    assert.equal(rendered.one(".dash-empty"), null, "loading is not the empty state");
    assert.ok(rendered.one(".dash-foot"), "loading is a foot line");
  } finally {
    win.__mockReleaseCommand?.("jobs_read");
  }
});
