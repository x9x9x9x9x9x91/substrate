/* Withdrawing consent stops the code NOW, not one round trip from now.
   `kinds_disable` deletes the record on disk and then asks the shared roster
   hook to re-read — and a re-read is an IPC round trip. Everything holding
   the previous roster went on serving it across that gap, so a pane resolved
   the kind to "enabled" and its code kept running, with the vault access
   consent buys, after the record granting it was gone.

   The gap is invisible to a test that lets the refetch land, because the
   refetch reports the withdrawal too and every assertion afterwards passes
   either way. So this test never disables anything: the backend still holds
   the record, the refetch RESTORES it, and the only place the drop can show
   up is the commit in between. A probe that records every roster it is handed
   catches exactly that commit — and catches nothing at all if the hook waits
   for the round trip. */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, useEffect } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";
import type { KindBundleInfo } from "./kinds.ts";

const ID = "gear-log";
const MANIFEST = JSON.stringify({
  id: ID,
  title: "Gear Log",
  api: 1,
  entry: "index.js",
});

let win: MockWindow;

before(async () => {
  win = await mockBackend();
  await win.__mockWriteKind({
    id: ID,
    manifest: MANIFEST,
    files: { "index.js": "export default { mount() {} };\n" },
    enabled: true,
  });
});

test("a withdrawal drops the consent record before the refetch confirms it", async (t) => {
  const { useKindBundles, invalidateKindBundles } = await import("../hooks/useKindBundles.ts");

  /* Every roster this consumer is COMMITTED, in order. Logged from an effect
     rather than from the render body so the record is of what the app showed,
     not of what React tried. */
  const seen: (KindBundleInfo[] | null)[] = [];
  function Probe() {
    const bundles = useKindBundles(true);
    useEffect(() => {
      seen.push(bundles);
    }, [bundles]);
    // the withdrawal is fired from inside the tree, so it lands in the same
    // act-wrapped turn a real button press would
    return h("button", { onClick: () => invalidateKindBundles(ID) }, "withdraw");
  }

  const r = await renderComponent(t, h(Probe));
  const recordOf = (rows: KindBundleInfo[] | null) =>
    rows?.find((b) => b.id === ID)?.record;

  assert.ok(recordOf(seen[seen.length - 1] ?? null), "the seeded kind starts out consented");
  const before = seen.length;

  await r.click("button");

  const after = seen.slice(before);
  assert.ok(after.length > 0, "the withdrawal committed at least one new roster");
  assert.ok(
    after.some((rows) => rows !== null && recordOf(rows) === undefined),
    "the record was dropped without waiting for kinds_list to answer",
  );
  /* And the backend still says enabled, so the roster comes back consented —
     which is what makes the assertion above about the WINDOW and not about
     the refetch having landed. */
  assert.ok(
    recordOf(seen[seen.length - 1] ?? null),
    "the refetch restored the record the backend still holds",
  );
});

test("an ordinary invalidation leaves every record alone", async (t) => {
  const { useKindBundles, invalidateKindBundles } = await import("../hooks/useKindBundles.ts");

  /* The one-directional half of the contract: a grant is never applied early,
     so an enable or a trust write — which call this with no id — must not
     flash the kind off and tear its code down on the way to saying yes. */
  const seen: (KindBundleInfo[] | null)[] = [];
  function Probe() {
    const bundles = useKindBundles(true);
    useEffect(() => {
      seen.push(bundles);
    }, [bundles]);
    return h("button", { onClick: () => invalidateKindBundles() }, "refresh");
  }

  const r = await renderComponent(t, h(Probe));
  const before = seen.length;
  await r.click("button");

  for (const rows of seen.slice(before)) {
    if (rows === null) continue;
    assert.ok(
      rows.find((b) => b.id === ID)?.record,
      "no commit dropped the record on a plain invalidation",
    );
  }
});
