/** WorkbookPane rendered for real — the public worked example of the
    component harness (`componentHarness.ts`; the pattern is written up in
    `docs/component-tests.md`).

    The workbook is a good second surface because its behaviour is a
    dispatch, not a formatter: `pages:` decides the tab strip, and each `note:`
    page routes on the TARGET note's type — sheet to the editable grid,
    dashboard back through `renderDashboard`, anything else to an error page
    that leaves its siblings alone. Every one of those reads folds case
    (`foldedTypeName`, `foldedPropStr`), and every fixture below is written
    the way a person types frontmatter: `Type: Sheet`, not `type: sheet`. */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const CASED_SHEET = "Weight Cased.md";
const CASED_DASH = "Dashboards/Goals Cased.md";
/** a note that is neither — the third arm of the dispatch */
const PLAIN_NOTE = "Workbook Plain.md";

function workbook(props: Record<string, unknown>): NoteMeta {
  return {
    path: "Dashboards/Workbook Cased.md",
    stem: "Workbook Cased",
    title: "Workbook Cased",
    folder: "Dashboards",
    props: { Type: "Dashboard", ...props },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

/** props every page shape needs; the tests vary only the workbook note */
function paneProps(meta: NoteMeta) {
  return {
    meta,
    notes: [] as NoteMeta[],
    vaultEpoch: 0,
    schema: {},
    savedViews: [],
    onOpenSource: () => {},
    onMutated: () => {},
    // page 0 is rendered by the caller in the app; here it just has to be
    // identifiable so the tab strip's first tab can be checked
    children: h("div", { className: "probe-page0" }, "page zero"),
    renderDashboard: (m: NoteMeta) =>
      h("div", { className: "probe-dashboard" }, `dashboard for ${m.title}`),
  };
}

/* not `Window`: `mockBackend` hands back a window the staging seams are
   present on, so these calls are written without `?.` — see its guard */
let win: MockWindow;

before(async () => {
  win = await mockBackend();
  for (const [source, copy] of [
    ["Weight Log.md", CASED_SHEET],
    ["Dashboards/Goals.md", CASED_DASH],
  ]) {
    win.__mockCloneNote(source, copy);
    win.__mockEditProp(copy, "type", null);
  }
  win.__mockEditProp(CASED_SHEET, "Type", "Sheet");
  win.__mockEditProp(CASED_DASH, "Type", "Dashboard");
  // no type at all — a plain note is not a workbook page
  win.__mockCloneNote("Weight Log.md", PLAIN_NOTE);
  win.__mockEditProp(PLAIN_NOTE, "type", null);
});

after(() => {
  for (const path of [CASED_SHEET, CASED_DASH, PLAIN_NOTE]) win.__mockDeleteNote(path);
});

test("builds the tab strip from a cased Pages: list", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(
      WorkbookPane,
      paneProps(
        workbook({
          PageLabel: "Ledger",
          Pages: [
            { label: "Weigh-ins", note: "Weight Cased" },
            { label: "Goals", note: "Goals Cased" },
          ],
        })
      )
    )
  );

  // page 0's label comes from the cased `PageLabel:`, not the "Overview" default
  assert.deepEqual(
    r.all(".wb-tab").map((el) => el.textContent),
    ["Ledger", "Weigh-ins", "Goals"]
  );
  assert.equal(r.all(".wb-tab.active")[0]?.textContent, "Ledger");
  assert.ok(r.one(".probe-page0"), "page 0 renders the caller's children");
});

test("routes a note page to the grid when the target's Type is cased", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(
      WorkbookPane,
      paneProps(workbook({ Pages: [{ label: "Weigh-ins", note: "Weight Cased" }] }))
    )
  );

  await r.click(r.all(".wb-tab")[1]);
  assert.equal(r.all(".wb-page-err").length, 0);
  assert.ok(r.one(".sheet-table"), "a sheet page renders the editable grid");
  // the grid is over the clone's rows, not an empty shell
  assert.match(r.text(), /2026-07-01/);
});

test("routes a note page to renderDashboard when the target is a cased dashboard", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(WorkbookPane, paneProps(workbook({ Pages: [{ label: "Goals", note: "Goals Cased" }] })))
  );

  await r.click(r.all(".wb-tab")[1]);
  assert.equal(r.one(".probe-dashboard")?.textContent, "dashboard for Goals Cased");
  assert.equal(r.all(".wb-page-err").length, 0);
});

test("a page pointing at neither kind fails in place, not across the strip", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(
      WorkbookPane,
      paneProps(
        workbook({
          Pages: [
            { label: "Plain", note: "Workbook Plain" },
            { label: "Weigh-ins", note: "Weight Cased" },
          ],
        })
      )
    )
  );

  await r.click(r.all(".wb-tab")[1]);
  assert.match(r.text(), /is not a sheet or dashboard/);
  // the sibling page still works — the error didn't take the workbook down
  await r.click(r.all(".wb-tab")[2]);
  assert.equal(r.all(".wb-page-err").length, 0);
  assert.ok(r.one(".sheet-table"));
});
