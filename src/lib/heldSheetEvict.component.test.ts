/** Text a failed sheet save is holding, and when the workbook lets go of it.
 *
 *  A refused write parks the typed body by note PATH, outside the page, so a
 *  tab switch cannot lose it — the page unmounts, the text waits, reopening
 *  takes it back still armed to retry. Nothing emptied that map except a save
 *  that lands, a reader discarding, or the trip back from time travel, so a
 *  deleted or renamed note's text sat in it for the app's lifetime, and a NEW
 *  note created at the freed path inherited it: the page opened showing
 *  somebody else's rows.
 *
 *  Both halves are pinned here, because they are one behaviour read two ways:
 *  a note still in the vault gets its held text back, and a path the vault no
 *  longer knows loses it.
 *
 *  Harness written up in `docs/component-tests.md`. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { act, createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { NoteMeta } from "./types.ts";

const SHEET = "Held Evict Sheet.md";
/** any second note, so the pane's note list is never empty — an empty list is
    a vault still loading, which must not read as a vault that lost every note */
const OTHER = "Held Evict Other.md";

let win: MockWindow;

function meta(path: string, type: string): NoteMeta {
  const stem = path.replace(/\.md$/, "");
  return {
    path,
    stem,
    title: stem,
    folder: "",
    props: { Type: type },
    updated_ms: Date.now(),
    excerpt: "",
    sealed: false,
  };
}

const WORKBOOK: NoteMeta = {
  ...meta("Held Evict Workbook.md", "Dashboard"),
  props: {
    Type: "Dashboard",
    Pages: [{ label: "Weigh-ins", note: SHEET.replace(/\.md$/, "") }],
  },
};

function paneProps(notes: NoteMeta[]): Record<string, unknown> {
  return {
    meta: WORKBOOK,
    notes,
    vaultEpoch: 0,
    schema: {},
    savedViews: [],
    onOpenSource: () => {},
    onMutated: () => {},
    children: h("div", { className: "probe-page0" }, "page zero"),
    renderDashboard: (m: NoteMeta) => h("div", null, `dashboard for ${m.title}`),
  };
}

type Pane = Awaited<ReturnType<typeof renderComponent>>;

async function mountWorkbook(
  t: Parameters<typeof renderComponent>[0],
  notes: NoteMeta[]
): Promise<Pane> {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const r = await renderComponent(t, h(WorkbookPane as never, paneProps(notes) as never));
  // page 0 is the workbook note's own kind; the sheet is the second tab
  const tabs = r.all(".wb-tab");
  assert.equal(tabs.length, 2, `unexpected tab strip: ${tabs.map((b) => b.textContent).join(" | ")}`);
  await r.click(tabs[1]);
  await r.settle();
  assert.ok(r.one(".sheet-table"), "the second tab did not render the sheet grid");
  return r;
}

/** The same workbook, over a note list the test can change under it — which
    is what a delete looks like to this pane, and the only way to put the
    eviction pass and a save's rejection in the order that races them. */
async function mountMutableWorkbook(
  t: Parameters<typeof renderComponent>[0],
  initial: NoteMeta[]
): Promise<{ pane: Pane; setNotes: (next: NoteMeta[]) => Promise<void> }> {
  const { default: WorkbookPane } = await import("../components/WorkbookPane.tsx");
  const { useState } = await import("react");
  let apply: ((next: NoteMeta[]) => void) | null = null;
  const Host = () => {
    const [notes, setNotes] = useState(initial);
    apply = setNotes;
    return h(WorkbookPane as never, paneProps(notes) as never);
  };
  const pane = await renderComponent(t, h(Host));
  const tabs = pane.all(".wb-tab");
  assert.equal(tabs.length, 2, `unexpected tab strip: ${tabs.map((b) => b.textContent).join(" | ")}`);
  await pane.click(tabs[1]);
  await pane.settle();
  assert.ok(pane.one(".sheet-table"), "the second tab did not render the sheet grid");
  return {
    pane,
    setNotes: async (next) => {
      assert.ok(apply, "the host never rendered");
      await act(async () => {
        apply!(next);
      });
      await pane.settle();
    },
  };
}

/** type a value into the grid's first data cell: double-click to open the
    editor, replace the draft, Enter to commit — the gesture the page's
    debounced save is armed by */
async function typeCell(r: Pane, value: string): Promise<void> {
  const cell = r.one(".sheet-cell");
  assert.ok(cell, "the sheet page rendered no grid cell to type into");
  await act(async () => {
    cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await r.settle();
  const input = r.one("input.sheet-input");
  assert.ok(input, "double-click opened no cell editor");
  const proto = Object.getPrototypeOf(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await r.settle();
}

before(async () => {
  win = await mockBackend();
  for (const path of [SHEET, OTHER]) {
    win.__mockCloneNote("Weight Log.md", path);
    win.__mockEditProp(path, "type", null);
    win.__mockEditProp(path, "Type", "Sheet");
  }
});

/** Leave a refused save's text parked under SHEET: type, move the note under
    the buffer, then unmount — leaving the page flushes, the write is refused
    on its guard, and the text is held by path. */
async function stageHeldText(t: Parameters<typeof renderComponent>[0], marker: string) {
  const r = await mountWorkbook(t, [meta(SHEET, "Sheet"), meta(OTHER, "Sheet")]);
  await typeCell(r, marker);
  // somebody else writes the note while the edit is pending: the flush below
  // is guarded against the body the page read, so it is refused
  win.__mockEditNote(SHEET, "Daily morning weigh-ins.\n\n```csv\ndate,kg\n2026-07-01,1.1\n```\n");
  await r.unmount();
  await new Promise((done) => setTimeout(done, 0));
}

test("a note still in the vault gets its held text back when the page reopens", async (t) => {
  await stageHeldText(t, "HELDMARKONE");

  const r = await mountWorkbook(t, [meta(SHEET, "Sheet"), meta(OTHER, "Sheet")]);
  assert.match(
    r.text(),
    /HELDMARKONE/,
    "the reopened page dropped the text a refused save was holding"
  );
});

test("a path the vault no longer lists loses its held text", async (t) => {
  await stageHeldText(t, "HELDMARKTWO");

  // the delete/rename event as the pane sees one: the sheet is gone from the
  // note list it is handed. The list is not empty — an empty one is a vault
  // still loading, not a vault that lost every note.
  const r = await mountWorkbook(t, [meta(OTHER, "Sheet")]);
  assert.doesNotMatch(
    r.text(),
    /HELDMARKTWO/,
    "the held text outlived the note it was typed into"
  );
  // the positive half of the absence claim: the page IS rendered, on the body
  // that is actually on disk
  assert.ok(r.one(".sheet-cell"), "the sheet page never rendered");
  assert.match(r.text(), /1,10/, "the page is not showing the note as it stands on disk");
});

/* Deletes the sheet from the mock vault and recreates it, so it goes last. */
test("a save refused after its note vanished parks nothing for the next note at that path", async (t) => {
  const { pane, setNotes } = await mountMutableWorkbook(t, [
    meta(SHEET, "Sheet"),
    meta(OTHER, "Sheet"),
  ]);
  await typeCell(pane, "HELDMARKRACE");

  /* The race the eviction pass alone cannot cover, in its real order: the note
     goes, the note list catches up and the eviction runs — finding NOTHING to
     drop, because the write has not been refused yet — and only then does the
     refusal arrive with a body to park. */
  win.__mockDeleteNote(SHEET);
  await setNotes([meta(OTHER, "Sheet")]);
  await pane.unmount();
  await new Promise((done) => setTimeout(done, 0));

  // a new note takes the freed path — retyping a name the vault just released
  // is ordinary, and it must open as itself
  win.__mockCloneNote("Weight Log.md", SHEET);
  win.__mockEditProp(SHEET, "type", null);
  win.__mockEditProp(SHEET, "Type", "Sheet");

  const r = await mountWorkbook(t, [meta(SHEET, "Sheet"), meta(OTHER, "Sheet")]);
  assert.doesNotMatch(
    r.text(),
    /HELDMARKRACE/,
    "the new note at that path inherited the deleted note's unsaved text"
  );
  // the positive half of the absence claim: the page rendered, on the new
  // note's own rows
  assert.ok(r.one(".sheet-cell"), "the sheet page never rendered");
  assert.match(r.text(), /2026-07-01/, "the page is not showing the note that is actually there");
});
