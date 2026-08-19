/** The windowed table's focus reveal, rendered for real through the component
    harness (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    A table past the windowing threshold paints only the rows around the
    scroll viewport, so a reveal aimed at a row deep in the set has no element
    to scroll to — the pane scrolls to the row's COMPUTED offset instead and
    re-windows around it. That whole fallback sat behind a guard that read the
    identity of the (absent) element, so it never ran: the reveal landed on a
    row nobody could see. Nothing about it is visible to tsc, and a browser
    spec pays minutes for it.

    jsdom has no layout, so the geometry the pane measures is defined on the
    nodes here (same move as `edgeFade.component.test.ts`): a fixed row height,
    a header, and a scroller with a real viewport height. Those are the only
    numbers the offset math reads, and `scrollTop` is a plain stored value in
    jsdom, so the scroll the pane performs is observable. What is NOT pinned
    here is anything requiring real layout — smooth scrolling, sticky headers,
    the browser's own scrollIntoView. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderComponent } from "./componentHarness.ts";
import type { NoteMeta, SavedViewSort } from "./types.ts";

/** past WIN_MIN (60) and past the overscan band, so the deep row below is
    genuinely outside the first painted window */
const ROWS = 200;
const DEEP = 180;
const ROW_H = 32;
const HEAD_H = 33;
const VIEW_H = 400;

/** zero-padded so the title sort below puts row N at index N */
const titleOf = (i: number) => `Row ${String(i).padStart(3, "0")}`;
const pathOf = (i: number) => `${titleOf(i)}.md`;

function row(i: number): NoteMeta {
  return {
    path: pathOf(i),
    stem: titleOf(i),
    title: titleOf(i),
    folder: "",
    props: { Type: "Release" },
    updated_ms: 0,
    excerpt: "",
    sealed: false,
  };
}

const NOTES = Array.from({ length: ROWS }, (_, i) => row(i));
const SORTS: SavedViewSort[] = [{ key: "title", dir: 1 }];

/** DatabasePane's required props, with everything this test doesn't drive
    inert — same shape as `saveViewControl.component.test.ts`. */
function paneProps(over: Record<string, unknown>): Record<string, unknown> {
  return {
    dbType: "Release",
    notes: NOTES,
    allNotes: NOTES,
    pref: { view: "table", sorts: SORTS },
    typeSchema: {},
    schema: { Release: {} },
    onSaveIcon: () => {},
    usedValues: () => [],
    onSaveSchema: () => {},
    relationCandidates: () => [],
    onCreateEntry: () => Promise.reject(new Error("not used")),
    dbTypes: ["Release"],
    openPath: null,
    newSignal: 0,
    gridDefault: false,
    onPrefChange: () => {},
    onOpenNote: () => {},
    onNoteMenu: () => {},
    onTrashNotes: () => {},
    onMutated: () => {},
    onSaveView: () => {},
    savedViews: [],
    pinKeys: {},
    onOpenView: () => {},
    onViewMenu: () => {},
    onRenameDb: () => {},
    onDeleteDb: () => {},
    onRenameProp: () => {},
    onRemoveProp: () => {},
    ...over,
  };
}

const scroller = (): HTMLElement | null => document.querySelector(".db-body");

/** The pane measures the row band it paints off the live DOM. jsdom computes
    none of it, so every rect the pane reads is answered here: the tbody rides
    the scroller (its top moves with scrollTop, as a real one does), which is
    what keeps the measured `tbodyTop` stable across a scroll instead of
    drifting by the distance just scrolled. */
function fakeLayout(t: { after: (fn: () => void) => void }): void {
  const realRect = Element.prototype.getBoundingClientRect;
  const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
  const rect = (top: number, height: number) =>
    ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const scrolled = scroller()?.scrollTop ?? 0;
    if (this.classList.contains("db-body")) return rect(0, VIEW_H);
    if (this.tagName === "THEAD") return rect(0, HEAD_H);
    if (this.tagName === "TBODY") return rect(HEAD_H - scrolled, ROWS * ROW_H);
    if (this.tagName === "TR") return rect(0, ROW_H);
    return rect(0, 0);
  };
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return this.classList.contains("db-body") ? VIEW_H : 0;
    },
  });

  t.after(() => {
    Element.prototype.getBoundingClientRect = realRect;
    if (realClientHeight) Object.defineProperty(Element.prototype, "clientHeight", realClientHeight);
  });
}

test("a windowed table paints only the band around the viewport", async (t) => {
  fakeLayout(t);
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  const r = await renderComponent(t, h(DatabasePane as never, paneProps({}) as never));

  // the positive half of the claim: the table is up and showing its top rows
  assert.ok(r.one(`[data-focus-path="${pathOf(0)}"]`), "the first row is painted");
  assert.equal(
    r.all(`[data-focus-path="${pathOf(DEEP)}"]`).length,
    0,
    "a row 180 down is outside the painted window — the premise of the test below"
  );
  assert.equal(scroller()?.scrollTop, 0, "nothing has asked for a scroll yet");
});

test("a reveal of a row outside the painted window scrolls to its computed offset", async (t) => {
  fakeLayout(t);
  const { default: DatabasePane } = await import("../components/DatabasePane.tsx");
  /* The reveal arrives the way App sends one — a path plus a request count.
     The pane queues it (pendingFocus), focus lands on the row, and the reveal
     effect finds no element for it: this is the fallback under test. */
  const r = await renderComponent(
    t,
    h(DatabasePane as never, paneProps({ reveal: { path: pathOf(DEEP), n: 1 } }) as never)
  );
  await r.settle();

  const body = scroller();
  assert.ok(body, "the scroller is up");
  const top = HEAD_H + DEEP * ROW_H;
  assert.ok(
    body.scrollTop > 0,
    `the revealed row sits at ${top}px; the pane never scrolled (scrollTop ${body.scrollTop})`
  );
  assert.ok(
    body.scrollTop <= top && top + ROW_H <= body.scrollTop + VIEW_H,
    `the revealed row (${top}–${top + ROW_H}) is outside the viewport ` +
      `(${body.scrollTop}–${body.scrollTop + VIEW_H})`
  );
  // and the window followed the scroll, so the row is now a real cell the
  // keyboard and the Enter-to-edit path can reach
  assert.ok(
    r.one(`[data-focus-path="${pathOf(DEEP)}"]`),
    "the revealed row is painted after the scroll"
  );
  assert.equal(
    r.all(`[data-focus-path="${pathOf(0)}"]`).length,
    0,
    "and the band moved rather than growing to cover both ends"
  );
});
