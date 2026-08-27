/** Proof that lifting the view-kind ternary into `<PaneRouter>` did not add a
 *  remount to the panes underneath it.
 *
 *  A new component boundary between App and the panes is exactly the kind of
 *  change that reads as free and is not: if the boundary's identity moved —
 *  the component declared inside App's body rather than at module scope, a
 *  wrapper keyed on something that churns — React would tear the whole pane
 *  subtree down and rebuild it on every unrelated App state change, and
 *  nothing about the rendered output would say so.
 *
 *  So it is pinned by DOM node identity: React reuses a host node only while
 *  the component that produced it stays mounted. The shelf pane's root node is
 *  captured once, and the same node object has to come back after an unrelated
 *  parent state change and after a `shelf → drive → shelf` round trip — both
 *  of which keep the same router arm, so a new node would mean a remount the
 *  ternary never used to cause.
 *
 *  The control at the end matters as much: switching to an arm that really is
 *  a different pane DOES give a fresh node, which is what tells "the identity
 *  assertion held" apart from "the assertion cannot fail".
 *
 *  What this does NOT prove: that App itself renders `<PaneRouter>` from
 *  module scope. That is a property of App's import, not of the router, and it
 *  is what the harness below stands in for. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { View } from "./types.ts";

/** Filled in by the test once the dynamic import has run — the router has to
    be imported after the harness installs the DOM globals. */
let Router: (props: { view: View; setView: (v: View) => void }) => ReactElement;

before(async () => {
  await mockBackend();
});

/** App in miniature: the view cell, one piece of state the router never reads,
    and the buttons that drive both. */
function Harness() {
  const [view, setView] = useState<View>({ kind: "shelf" });
  const [tick, setTick] = useState(0);
  return h(
    "div",
    null,
    h("button", { type: "button", className: "bump", onClick: () => setTick((t) => t + 1) }, `tick ${tick}`),
    h(
      "button",
      { type: "button", className: "to-drive", onClick: () => setView({ kind: "drive", id: "probe", prefix: "" }) },
      "drive"
    ),
    h("button", { type: "button", className: "to-shelf", onClick: () => setView({ kind: "shelf" }) }, "shelf"),
    h("button", { type: "button", className: "to-assets", onClick: () => setView({ kind: "assets" }) }, "assets"),
    h(Router, { view, setView })
  );
}

test("a view round-trip through PaneRouter does not remount the pane", async (t) => {
  const { default: PaneRouter } = await import("../components/PaneRouter.tsx");
  // the shelf, drive and assets arms read three props between them; the rest
  // of the belt feeds arms this test never renders, and standing all ~130 of
  // them up would pin nothing that the ternary itself does not already pin
  Router = ({ view, setView }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h(PaneRouter, { view, setView, vaultEpoch: 0 } as any);

  const r = await renderComponent(t, h(Harness));
  await r.settle();

  const pane = r.one(".trash.shelf");
  assert.ok(pane, "the shelf pane rendered");
  assert.match(r.text(), /tick 0/);

  await r.click(".bump");
  await r.settle();
  assert.match(r.text(), /tick 1/, "the unrelated state actually changed");
  assert.strictEqual(r.one(".trash.shelf"), pane, "an unrelated parent render did not remount the pane");

  await r.click(".to-drive");
  await r.settle();
  assert.strictEqual(r.one(".trash.shelf"), pane, "moving to the drive catalog kept the same pane mounted");

  await r.click(".to-shelf");
  await r.settle();
  assert.strictEqual(r.one(".trash.shelf"), pane, "the round trip came back to the same pane, not a new one");

  // Control: an arm that is a different pane, which SHOULD remount — without
  // this the identity assertions above would pass on a router that never
  // re-rendered at all.
  await r.click(".to-assets");
  await r.settle();
  assert.ok(r.one(".trash.assets"), "the assets pane took over the main column");
  assert.equal(r.all(".trash.shelf").length, 0, "the shelf pane really did unmount");

  await r.click(".to-shelf");
  await r.settle();
  const rebuilt = r.one(".trash.shelf");
  assert.ok(rebuilt, "the shelf pane came back");
  assert.notStrictEqual(rebuilt, pane, "a genuine remount does produce a new node — the checks above can fail");
});
