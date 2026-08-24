/** WorkbookPane rendered for real — the public worked example of the
    component harness (`componentHarness.ts`; the pattern is written up in
    `docs/component-tests.md`).

    The workbook is a good second surface because its behaviour is a
    dispatch, not a formatter: `pages:` decides the tab strip, and each `note:`
    page routes on the TARGET note's type — sheet to the editable grid,
    dashboard back through `renderDashboard`, anything else to an error page
    that leaves its siblings alone — and a dashboard carrying pages of its own
    routes through a switcher over THOSE, one level deep, which is the thing
    that keeps a cycle finite. Every one of those reads folds case
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
/** a dashboard carrying a `pages:` list of its OWN — the nesting case */
const NESTED_DASH = "Dashboards/Nested Cased.md";
/** two dashboards whose pages: lists point at each other */
const CYCLE_A = "Dashboards/Cycle A.md";
const CYCLE_B = "Dashboards/Cycle B.md";
/** a dashboard whose pages: list names itself — the nested-owner guard */
const SELF_DASH = "Dashboards/Self Cased.md";

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

  /* the nesting fixtures. Written the way a person types frontmatter, and
     each list deliberately mixes a page that renders with pages that fail,
     so one switcher covers the dispatch and both error arms. */
  for (const path of [NESTED_DASH, CYCLE_A, CYCLE_B, SELF_DASH]) {
    win.__mockCloneNote("Dashboards/Goals.md", path);
    win.__mockEditProp(path, "type", null);
    win.__mockEditProp(path, "Type", "Dashboard");
  }
  win.__mockEditProp(NESTED_DASH, "PageLabel", "Summary");
  win.__mockEditProp(NESTED_DASH, "Pages", [
    { label: "Sheets", note: "Weight Cased" },
    { label: "Gone", note: "No Such Note At All" },
    { label: "Plain", note: "Workbook Plain" },
  ]);
  win.__mockEditProp(CYCLE_A, "Pages", [{ label: "Over to B", note: "Cycle B" }]);
  win.__mockEditProp(CYCLE_B, "Pages", [{ label: "Back to A", note: "Cycle A" }]);
  win.__mockEditProp(SELF_DASH, "Pages", [
    { label: "Me", note: "Self Cased" },
    { label: "Sheets", note: "Weight Cased" },
  ]);
});

after(() => {
  for (const path of [CASED_SHEET, CASED_DASH, PLAIN_NOTE, NESTED_DASH, CYCLE_A, CYCLE_B, SELF_DASH])
    win.__mockDeleteNote(path);
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
  assert.doesNotMatch(r.text(), /can’t render/);
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
  assert.doesNotMatch(r.text(), /can’t render/);
  // a target with no pages: of its own grows no switcher — the flat case
  assert.equal(r.all(".wb-subpages").length, 0);
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
  assert.doesNotMatch(r.text(), /can’t render/);
  assert.ok(r.one(".sheet-table"));
});

test("an embedded dashboard with pages of its own gets a switcher, not a flatten", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(WorkbookPane, paneProps(workbook({ Pages: [{ label: "Tax", note: "Nested Cased" }] })))
  );

  await r.click(r.all(".wb-tab")[1]);
  // slot 0 is the target itself, labelled by ITS cased PageLabel:
  assert.deepEqual(
    r.all(".wb-subpages button").map((el) => el.textContent),
    ["Summary", "Sheets", "Gone", "Plain"]
  );
  assert.equal(r.one(".wb-subpages")?.getAttribute("aria-label"), "Dashboard page");
  assert.equal(r.one(".probe-dashboard")?.textContent, "dashboard for Nested Cased");
  // the bottom strip still belongs to the workbook, not to the target
  assert.deepEqual(
    r.all(".wb-tab").map((el) => el.textContent),
    ["Overview", "Tax"]
  );

  // switching renders the target's own sheet page as the editable grid
  await r.click(r.all(".wb-subpages button")[1]);
  assert.ok(r.one(".sheet-table"), "a sheet sub-page renders the editable grid");
  assert.match(r.text(), /2026-07-01/);
  assert.doesNotMatch(r.text(), /can’t render/);
});

test("a broken sub-page fails inside the switcher, not across it", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(WorkbookPane, paneProps(workbook({ Pages: [{ label: "Tax", note: "Nested Cased" }] })))
  );

  await r.click(r.all(".wb-tab")[1]);
  await r.click(r.all(".wb-subpages button")[2]);
  assert.match(r.text(), /no note named “No Such Note At All”/);
  await r.click(r.all(".wb-subpages button")[3]);
  assert.match(r.text(), /is not a sheet or dashboard/);
  // the switcher survived both, and its working sibling still renders
  await r.click(r.all(".wb-subpages button")[1]);
  assert.ok(r.one(".sheet-table"));
  assert.doesNotMatch(r.text(), /can’t render/);
});

test("switching workbook tabs resets the switcher, even between tabs naming the same note", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(
      WorkbookPane,
      paneProps(
        workbook({
          Pages: [
            { label: "Tax", note: "Nested Cased" },
            { label: "Tax again", note: "Nested Cased" },
          ],
        })
      )
    )
  );

  await r.click(r.all(".wb-tab")[1]);
  await r.click(r.all(".wb-subpages button")[1]);
  assert.equal(r.one(".wb-subpages button.active")?.textContent, "Sheets");

  // the same note under a different tab is a different page: slot 0 again
  await r.click(r.all(".wb-tab")[2]);
  assert.equal(r.one(".wb-subpages button.active")?.textContent, "Summary");
  assert.ok(r.one(".probe-dashboard"), "the fresh page opens on the target itself");
});

test("a sub-page naming the embedded note itself fails against the right workbook", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(WorkbookPane, paneProps(workbook({ Pages: [{ label: "Self", note: "Self Cased" }] })))
  );

  await r.click(r.all(".wb-tab")[1]);
  // the guard measures against the note the pages: list belongs to — the
  // embedded dashboard, not the outer workbook
  await r.click(r.all(".wb-subpages button")[1]);
  assert.match(r.text(), /a page can’t point at its own workbook/);
  // its sibling sub-page is untouched by the refusal
  await r.click(r.all(".wb-subpages button")[2]);
  assert.ok(r.one(".sheet-table"));
});

test("nesting stops at one level, so a two-note cycle terminates", async (t) => {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(WorkbookPane, paneProps(workbook({ Pages: [{ label: "A", note: "Cycle A" }] })))
  );

  await r.click(r.all(".wb-tab")[1]);
  assert.deepEqual(
    r.all(".wb-subpages button").map((el) => el.textContent),
    ["Overview", "Over to B"]
  );

  // B is a dashboard reached from inside a switcher: it renders FLAT, so its
  // own page back to A never appears and the render terminates
  await r.click(r.all(".wb-subpages button")[1]);
  assert.equal(r.one(".probe-dashboard")?.textContent, "dashboard for Cycle B");
  assert.equal(r.all(".wb-subpages").length, 1, "no second switcher below the first");
  assert.doesNotMatch(r.text(), /Back to A/);
});
