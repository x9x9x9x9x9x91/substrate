/** The edge-fade gate rendered for real, through the component harness
    (`componentHarness.ts`, pattern in `docs/component-tests.md`).

    Two behaviours that only exist at commit time, so tsc and the browser
    specs both walk past them:

      1. A hook instance whose scroller MOVES (the calendar's expanded month
         cell rides one instance as expansion travels between days) must not
         carry the old node's `scrolled/more` onto the new one — that paints
         the next cell's fade from the previous cell's overflow for a frame.
      2. The two db layouts merge the fade's callback ref with the bodyRef
         DatabasePane owns. An inline closure hands React a new ref identity
         every render, so React detaches and re-attaches the node on every
         pass; the merge has to be memoised.

    Both are asserted on the ref traffic and the class string rather than on
    layout: jsdom has no layout, so the scroll metrics are defined on the
    nodes and `requestAnimationFrame` is replaced by a queue the test pumps —
    the hook's first gate is deliberately one frame late, and the residue
    being tested lives inside exactly that frame. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useState } from "react";
import { renderComponent } from "./componentHarness.ts";

/** Give a jsdom node the scroll geometry it has no layout to compute. */
function fakeMetrics(node: Element, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(node, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(node, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(node, "scrollTop", { value: 0, writable: true, configurable: true });
}

test("moving the fade to another scroller drops the old node's state", async (t) => {
  const { useEdgeFade } = await import("../hooks/useEdgeFade.ts");

  /* The hook gates one frame after attach, on purpose. Owning the queue is
     what makes the residue observable at all: pumped by hand, the window
     between attach and first gate is a place the test can stand. */
  const frames: Array<() => void> = [];
  /* React's own act typing takes a sync or async scope; the pump is sync. */
  const pumpFrames = async () => {
    await act(async () => {
      frames.splice(0).forEach((run) => run());
    });
  };
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    frames.push(() => cb(0))) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  t.after(() => {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
  });

  /* One hook, two scrollers, one at a time — the calendar's shape. */
  function Probe() {
    const [onB, setOnB] = useState(false);
    const fade = useEdgeFade<HTMLDivElement>();
    return h(
      "div",
      null,
      h("button", { onClick: () => setOnB(true) }, "swap"),
      h("div", {
        className: `pa${onB ? "" : fade.className}`,
        ...(onB ? {} : fade.props),
      }),
      h("div", {
        className: `pb${onB ? fade.className : ""}`,
        ...(onB ? fade.props : {}),
      })
    );
  }

  const r = await renderComponent(t, h(Probe));
  const a = r.one(".pa");
  const b = r.one(".pb");
  assert.ok(a && b, "both probe scrollers rendered");
  fakeMetrics(a, 500, 100); // A overflows: the gate should fade its bottom
  fakeMetrics(b, 50, 100); // B fits in its box: no fade at all

  await r.settle();
  await pumpFrames();
  await r.settle();
  assert.match(a.className, /edge-more-y/, "A overflows, so its bottom fades");

  await r.click("button");
  /* No frame pumped: this is the render right after the swap, before the
     post-attach gate. B fits its box, so it must not be fading — carrying A's
     `more` across the swap is the ghost frame. */
  assert.ok(
    !/edge-more-y/.test(b.className),
    `B fits its box but is fading from A's overflow: ${b.className}`
  );
  await pumpFrames();
  await r.settle();
  assert.ok(!/edge-more-y/.test(b.className), "and still not fading once the gate lands");
});

test("a caller whose merged ref is an inline closure keeps its fade", async (t) => {
  const { useEdgeFade } = await import("../hooks/useEdgeFade.ts");

  /* The palette merges the fade ref with its own listRef inline, so React
     hands the hook detach(node)+attach(node) on every render — same node, so
     the observer effect does not re-run. Dropping the gate state on detach
     without re-taking it at attach blanks the fade on the first re-render and
     never restores it. */
  function Probe() {
    const [n, setN] = useState(0);
    const own = { current: null as HTMLDivElement | null };
    const fade = useEdgeFade<HTMLDivElement>();
    return h(
      "div",
      null,
      h("button", { onClick: () => setN(n + 1) }, "rerender"),
      h("div", {
        className: `pc${fade.className}`,
        ref: (node: HTMLDivElement | null) => {
          own.current = node;
          fade.props.ref(node);
        },
        onScroll: fade.props.onScroll,
      })
    );
  }

  const r = await renderComponent(t, h(Probe));
  const c = r.one(".pc");
  assert.ok(c, "probe scroller rendered");
  fakeMetrics(c, 500, 100);

  await r.click("button"); // re-render: detach + attach, same node
  await r.settle();
  assert.match(
    c.className,
    /edge-more-y/,
    `the scroller still overflows, so its bottom must still fade: ${c.className}`
  );
});

/** A bodyRef that records every assignment. DatabasePane hands the layouts a
    real RefObject; what matters here is the traffic, not the value. */
function recordingRef() {
  const seen: Array<HTMLDivElement | null> = [];
  let node: HTMLDivElement | null = null;
  return {
    seen,
    ref: {
      get current() {
        return node;
      },
      set current(value: HTMLDivElement | null) {
        node = value;
        seen.push(value);
      },
    } as React.RefObject<HTMLDivElement | null>,
  };
}

const LAYOUTS = [
  { name: "DbListLayout", path: "../components/DbListLayout.tsx", extra: { curated: undefined } },
  {
    name: "DbGalleryLayout",
    path: "../components/DbGalleryLayout.tsx",
    extra: { dbType: "Release" },
  },
] as const;

for (const layout of LAYOUTS) {
  test(`${layout.name} keeps its merged body ref across renders`, async (t) => {
    const { default: Layout } = (await import(layout.path)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    const { seen, ref } = recordingRef();
    const props = {
      rows: [],
      typeSchema: {},
      numberLocale: "de-DE",
      openPath: null,
      bgMenuProps: { onContextMenu: () => {} },
      head: null,
      tabRow: null,
      bar: null,
      noMatch: null,
      adminPop: null,
      draftRow: null,
      bodyRef: ref,
      focusedCls: () => "",
      tabIndexFor: () => 0,
      setFocus: () => {},
      onOpenNote: () => {},
      onNoteMenu: () => {},
      ...layout.extra,
    };

    /* A parent that re-renders the layout with identical props — the pass
       React should be able to bail out of. */
    function Host() {
      const [n, setN] = useState(0);
      return h(
        "div",
        null,
        h("button", { onClick: () => setN(n + 1) }, "rerender"),
        h(Layout as never, props as never)
      );
    }

    const r = await renderComponent(t, h(Host));
    assert.equal(seen.length, 1, "one attach on mount");
    assert.ok(seen[0], "and it is the node, not null");

    await r.click("button");
    assert.deepEqual(
      seen.length,
      1,
      `re-render churned the body ref (${seen.map((v) => (v ? "node" : "null")).join(", ")}) — ` +
        `the merged ref must keep its identity`
    );
  });
}
