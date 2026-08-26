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
import { act, createElement as h } from "react";
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

/* Which page is open belongs to the note being read. The swap is driven
   through DashboardPane because that is where the app renders the pane from
   and where the reset lives: the defect was a parent handing the SAME pane
   element a different note, so a test that mounts WorkbookPane per note walks
   straight past it. */
const SWAP_A = "Dashboards/Swap A.md";
const SWAP_B = "Dashboards/Swap B.md";

function swapMeta(path: string, label: string, pages: string[]): NoteMeta {
  const stem = path.split("/").pop()!.replace(/\.md$/, "");
  return {
    path,
    stem,
    title: stem,
    folder: "Dashboards",
    props: {
      Type: "Dashboard",
      PageLabel: label,
      Pages: pages.map((p) => ({ label: p, note: "Weight Cased" })),
    },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

test("a second workbook opens on its own first page, not the last one's tab", async (t) => {
  const react = await import("react");
  const { default: DashboardPane } = await import("../components/DashboardPane.tsx");

  for (const [path, label, pages] of [
    [SWAP_A, "Finance", ["Cash", "Tax"]],
    // deliberately shorter: a clamp would land this one on its LAST tab, which
    // looks like a reset until the target has fewer pages than the tab index
    [SWAP_B, "Studio", ["Gear"]],
  ] as [string, string, string[]][]) {
    win.__mockCloneNote("Dashboards/Goals.md", path);
    win.__mockEditProp(path, "type", null);
    win.__mockEditProp(path, "Type", "Dashboard");
    win.__mockEditProp(path, "PageLabel", label);
    win.__mockEditProp(
      path,
      "Pages",
      pages.map((label) => ({ label, note: "Weight Cased" }))
    );
  }
  t.after(() => {
    win.__mockDeleteNote(SWAP_A);
    win.__mockDeleteNote(SWAP_B);
  });

  const a = swapMeta(SWAP_A, "Finance", ["Cash", "Tax"]);
  const b = swapMeta(SWAP_B, "Studio", ["Gear"]);
  function Switcher() {
    const [meta, setMeta] = react.useState(a);
    return h(
      "div",
      null,
      h("button", { className: "probe-swap", onClick: () => setMeta(b) }, "swap"),
      h(DashboardPane, {
        meta,
        notes: [a, b],
        vaultEpoch: 0,
        schema: {},
        onOpenSource: () => {},
        onMutated: () => {},
      })
    );
  }

  const r = await renderComponent(t, h(Switcher));
  assert.deepEqual(
    r.all(".wb-tab").map((el) => el.textContent),
    ["Finance", "Cash", "Tax"]
  );
  await r.click(r.all(".wb-tab")[2]);
  assert.equal(r.all(".wb-tab.active")[0]?.textContent, "Tax");

  await r.click(".probe-swap");
  await r.settle();
  assert.deepEqual(
    r.all(".wb-tab").map((el) => el.textContent),
    ["Studio", "Gear"]
  );
  assert.equal(
    r.all(".wb-tab.active")[0]?.textContent,
    "Studio",
    "the second workbook opens on its own page 0"
  );
});

/* A sheet page's save can be refused — the note changed on disk under the
   buffer, or it is gone — and the refusal used to re-read disk and remount the
   grid on what it found, taking every typed cell off the screen with nothing
   said. Same discipline as NotePane: hold the text, say so, and reload only
   when the reader asks for it. */
const SAVE_SHEET = "Save Fail Sheet.md";
const OVERWRITE_SHEET = "Overwrite Sheet.md";
const RETRY_SHEET = "Retry Sheet.md";
const TYPED = "typed by me";
const ELSEWHERE = "changed elsewhere";
const sheetBody = (cell: string) => "```csv\nasset,note\nBTC," + cell + "\n```\n";

/** open the workbook's sheet page, with the failure surfaces wired */
async function sheetPage(
  t: Parameters<typeof renderComponent>[0],
  toasts: string[],
  note = "Save Fail Sheet"
) {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(
    t,
    h(WorkbookPane, {
      ...paneProps(workbook({ Pages: [{ label: "Sheet", note }] })),
      onToast: (msg: string) => toasts.push(msg),
    })
  );
  await r.click(r.all(".wb-tab")[1]);
  return r;
}

/** leave the page and come back — the tab strip unmounts it, which is what
    flushes a pending edit and what makes the next open re-read */
async function reopen(r: Awaited<ReturnType<typeof renderComponent>>): Promise<void> {
  await r.click(r.all(".wb-tab")[0]);
  await r.settle();
  await r.click(r.all(".wb-tab")[1]);
  await r.settle();
}

/** double-click a cell, type, commit — the grid's own edit gesture */
async function editCell(
  r: Awaited<ReturnType<typeof renderComponent>>,
  value: string
): Promise<void> {
  const cell = r.all("tbody tr:not(.sheet-addrow):not(.sheet-totals) .sheet-cell")[1];
  assert.ok(cell, "the row's second cell is there to type into");
  await act(async () => {
    cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  const input = r.one(".sheet-input");
  assert.ok(input, "double-click opened the cell editor");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await r.settle();
}

/** the page's 500ms debounce is real time — outlast it, then let the write's
    rejection land */
async function settleWrite(r: Awaited<ReturnType<typeof renderComponent>>): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 600));
  });
  await r.settle();
}

/** the note as it stands in the mock vault */
const diskBody = (path: string) =>
  (win.__mockNotesDump?.() ?? []).find((n) => n.path === path)?.body ?? "";

/** stage the sheet fixture fresh for one test */
function stageSheet(t: Parameters<typeof renderComponent>[0], path: string, cell: string) {
  win.__mockCloneNote("Weight Log.md", path);
  win.__mockEditProp(path, "type", null);
  win.__mockEditProp(path, "Type", "Sheet");
  win.__mockEditNote(path, sheetBody(cell));
  t.after(() => win.__mockDeleteNote(path));
}

test("a note that changed on disk holds the typing and asks whose version wins", async (t) => {
  stageSheet(t, SAVE_SHEET, "keep");

  const toasts: string[] = [];
  const r = await sheetPage(t, toasts);
  assert.ok(r.one(".sheet-table"), "the sheet page renders the grid");

  // somebody else rewrites the note while the page holds it open: the next
  // guarded write is refused, which is the whole precondition
  win.__mockEditNote(SAVE_SHEET, sheetBody(ELSEWHERE));
  await editCell(r, TYPED);
  await settleWrite(r);

  assert.match(r.text(), new RegExp(TYPED), "the refusal took the typed cell off the screen");
  assert.doesNotMatch(r.text(), new RegExp(ELSEWHERE), "the grid remounted on the disk body");
  assert.ok(r.one(".sheet-table"), "the page went blank instead of holding its text");
  assert.match(r.text(), /changed on disk/, "the failure was silent, or named the wrong cause");
  assert.doesNotMatch(r.text(), /click to retry/, "a retry would be refused for the same reason");

  // leaving the page flushes on the way out and is refused again — the page
  // that would have shown the pill is gone, so the toast carries it
  await r.click(r.all(".wb-tab")[0]);
  await settleWrite(r);
  assert.ok(
    toasts.some((m) => /your text is held/.test(m)),
    "a save that failed while leaving said nothing at all"
  );

  // …and the text comes back with the page, on the base it was written
  // against, so the flush the NEXT tab switch fires is refused too rather than
  // quietly winning over the edit that arrived in between
  await r.click(r.all(".wb-tab")[1]);
  await r.settle();
  assert.match(r.text(), new RegExp(TYPED), "the held text did not come back with the page");
  assert.match(r.text(), /changed on disk/);

  await r.click(r.all(".wb-tab")[0]);
  await settleWrite(r);
  assert.match(
    diskBody(SAVE_SHEET),
    new RegExp(ELSEWHERE),
    "reopening rebased the held text and overwrote somebody else's edit"
  );
  assert.doesNotMatch(diskBody(SAVE_SHEET), new RegExp(TYPED));
});

test("the overwrite door lands the held text, deliberately", async (t) => {
  stageSheet(t, OVERWRITE_SHEET, "keep");
  const r = await sheetPage(t, [], "Overwrite Sheet");

  win.__mockEditNote(OVERWRITE_SHEET, sheetBody(ELSEWHERE));
  await editCell(r, TYPED);
  await settleWrite(r);
  assert.match(r.text(), /changed on disk/);

  // the reader chooses to win: the note as it stands becomes the base, and the
  // held text is written over it
  const overwriteButton = r.all(".save-error").find((b) => /overwrite with mine/.test(b.textContent ?? ""));
  assert.ok(overwriteButton, "the conflict offers no way to keep your own version");
  await r.click(overwriteButton);
  await settleWrite(r);

  assert.match(diskBody(OVERWRITE_SHEET), new RegExp(TYPED), "the overwrite never reached the note");
  assert.doesNotMatch(r.text(), /changed on disk/, "the pill stayed up after a save that landed");

  // and the held entry is gone with it — a later leave writes nothing new
  await r.click(r.all(".wb-tab")[0]);
  await settleWrite(r);
  assert.match(diskBody(OVERWRITE_SHEET), new RegExp(TYPED));
});

test("a transient failure keeps the retry pill, and the retry lands", async (t) => {
  stageSheet(t, RETRY_SHEET, "keep");
  const r = await sheetPage(t, [], "Retry Sheet");

  // nothing moved on disk — the write simply did not go through
  win.__mockFailOnce?.("vault_write_body");
  await editCell(r, TYPED);
  await settleWrite(r);
  assert.match(r.text(), /save failed/, "a transient failure is not a conflict");
  assert.doesNotMatch(r.text(), /changed on disk/);
  assert.match(r.text(), new RegExp(TYPED), "the typed cell left the screen");

  await r.click(".save-error");
  await settleWrite(r);
  assert.match(diskBody(RETRY_SHEET), new RegExp(TYPED), "the in-place retry never reached the note");
  assert.doesNotMatch(r.text(), /save failed/);
});

/* Time travel's one absolute: text typed while a HISTORICAL body is on screen
   must never reach the live file. A sheet page renders the projection like any
   other read, the debounced save is refused by the read-only guard, and a page
   that held that text would hand it to the live note the moment it was
   reopened in the present — and the tab switch that unmounts it would flush it
   there without anyone asking. */
const PAST_SHEET = "Past Sheet.md";
const PAST_TYPED = "typed in the past";
/* the fence sits at the top and the prose pads it out, because the mock's
   oldest snapshot is the body's first third — a fence truncated mid-way is not
   a sheet at all, and the page would have no cell to type into */
const PAST_BODY =
  "```csv\nasset,note\nBTC,live\n```\n" + "prose\n".repeat(8);

test("a sheet edit made in the past never lands on the live note", async (t) => {
  const { historyEnter, historyLeave, historyPoints } = await import("./ipc.ts");
  win.__mockCloneNote("Weight Log.md", PAST_SHEET);
  win.__mockEditProp(PAST_SHEET, "type", null);
  win.__mockEditProp(PAST_SHEET, "Type", "Sheet");
  win.__mockEditNote(PAST_SHEET, PAST_BODY);
  t.after(() => win.__mockDeleteNote(PAST_SHEET));

  const toasts: string[] = [];
  const r = await sheetPage(t, toasts, "Past Sheet");
  assert.ok(r.one(".sheet-table"), "the live sheet page renders the grid");

  // into the past, and back onto the page so it re-reads the projection
  const points = await historyPoints();
  const oldest = points[points.length - 1]!;
  let inPast = true;
  t.after(() => {
    if (inPast) historyLeave();
  });
  await historyEnter(oldest.id);
  await reopen(r);
  assert.ok(r.one(".sheet-table"), "the historical body still renders as a sheet");

  await editCell(r, PAST_TYPED);
  await settleWrite(r);
  assert.match(r.text(), /viewing the past/, "the refusal was silent");
  assert.doesNotMatch(r.text(), /click to retry/, "a retry here would be a dead end");

  historyLeave();
  inPast = false;

  // back in the present: reopening the page must not adopt the past text, and
  // the unmount flush on the way must not carry it to the file either
  await reopen(r);
  await settleWrite(r);
  assert.doesNotMatch(r.text(), new RegExp(PAST_TYPED), "the page adopted text from the past");
  const onDisk = (win.__mockNotesDump?.() ?? []).find((n) => n.path === PAST_SHEET)?.body ?? "";
  assert.doesNotMatch(onDisk, new RegExp(PAST_TYPED), "past text landed on the live note");
  assert.match(onDisk, /BTC,live/, "the live body survived the trip");
  assert.deepEqual(toasts, [], "nothing was held, so nothing claimed to be");
});

test("a note deleted under the page holds the cells and says the note is gone", async (t) => {
  const GONE_SHEET = "Gone Sheet.md";
  win.__mockCloneNote("Weight Log.md", GONE_SHEET);
  win.__mockEditProp(GONE_SHEET, "type", null);
  win.__mockEditProp(GONE_SHEET, "Type", "Sheet");
  win.__mockEditNote(GONE_SHEET, sheetBody("keep"));
  const r = await sheetPage(t, [], "Gone Sheet");

  // the file leaves the vault while the page holds it open — the engine never
  // resurrects one, so no retry can succeed and none is offered
  win.__mockDeleteNote(GONE_SHEET);
  await editCell(r, TYPED);
  await settleWrite(r);

  assert.match(r.text(), /note is gone/, "the vanished note was reported as a save failure");
  assert.doesNotMatch(r.text(), /click to retry/, "a retry against a deleted note is a dead end");
  assert.match(r.text(), new RegExp(TYPED), "the cells went with the file");
});
