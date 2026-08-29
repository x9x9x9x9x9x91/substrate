/** A bulk sweep whose safety snapshot failed does not run (docs/undo.md §6.5).
 *
 *  Every schema sweep opens by committing the vault, so there is a point to
 *  come back to if a rewrite of hundreds of notes turns out to be wrong. The
 *  snapshot's own failure used to be caught into `false` — the same value that
 *  means "this vault has no history at all" — so a failed commit was reported
 *  as a known-unprotected sweep and the rewrite went ahead anyway. Those are
 *  different states and only one of them may proceed.
 *
 *  Driven through the admin hook rather than the pure helper, because what
 *  matters is that nothing downstream of the snapshot ran: no vault call, no
 *  reload, no completion toast — and that the message the dialog shows says
 *  the vault is untouched. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h, useEffect } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";
import { errText } from "./errtext.ts";
import { presweep } from "./sweep.ts";

type UseDbAdmin = typeof import("../hooks/useDbAdmin.ts").useDbAdmin;
type Admin = ReturnType<UseDbAdmin>;

let useDbAdmin: UseDbAdmin;

before(async () => {
  await mockBackend();
  ({ useDbAdmin } = await import("../hooks/useDbAdmin.ts"));
});

/** what the hook touched on the way through — every one of these lines is
    downstream of the snapshot, so a set that stays empty is the proof */
type Traffic = { toasts: string[]; reloads: number; refreshes: number };

function Probe({ sink, traffic }: { sink: (a: Admin) => void; traffic: Traffic }): null {
  const admin = useDbAdmin({
    notes: [],
    folders: [],
    schema: {},
    setSchema: () => {},
    setView: () => {},
    refresh: () => {
      traffic.refreshes++;
    },
    showToast: (msg) => {
      traffic.toasts.push(msg);
    },
    reloadDbMeta: () => {
      traffic.reloads++;
    },
    reloadSidebarOrder: () => {},
    // the vault has history, and committing it failed — the case that must
    // stop the sweep rather than proceed with a warning
    presweepSnapshot: (label) =>
      presweep(() => Promise.reject(new Error("could not write index")), label),
    restoreFromSnapshot: () => {},
    schemaDbKey: (db) => db,
    schemaPropKey: (_db, prop) => prop,
    record: () => {},
  });
  useEffect(() => {
    sink(admin);
  }, [admin, sink]);
  return null;
}

async function mountAdmin(t: Parameters<typeof renderComponent>[0], traffic: Traffic) {
  let admin: Admin | null = null;
  await renderComponent(t, h(Probe, { sink: (a: Admin) => (admin = a), traffic }));
  assert.ok(admin, "the probe rendered without exposing the hook");
  return admin as Admin;
}

const blank = (): Traffic => ({ toasts: [], reloads: 0, refreshes: 0 });

test("a failed snapshot stops the delete before a single note moves", async (t) => {
  const traffic = blank();
  const admin = await mountAdmin(t, traffic);

  const failure = await admin.deleteDatabase("Books", true).then(
    () => null,
    (e: unknown) => errText(e)
  );

  assert.ok(failure, "the sweep ran without a snapshot instead of refusing");
  assert.match(failure, /nothing was changed/, "the dialog has to say the vault is untouched");
  assert.match(failure, /could not write index/, "and why the snapshot failed");
  assert.doesNotMatch(
    failure,
    /no safety snapshot taken/,
    "that phrasing belongs to a sweep that RAN unprotected — here nothing ran"
  );
  assert.deepEqual(traffic.toasts, [], "a completion toast would claim work that never happened");
  assert.equal(traffic.reloads + traffic.refreshes, 0, "nothing downstream of the snapshot ran");
});

test("the same refusal covers the property sweeps", async (t) => {
  const traffic = blank();
  const admin = await mountAdmin(t, traffic);

  for (const run of [
    () => admin.renameDatabase("Books", "Albums"),
    () => admin.renameProperty("Books", "status", "state"),
    () => admin.stripPropValues("Books", "status", false),
  ]) {
    const failure = await run().then(
      () => null,
      (e: unknown) => errText(e)
    );
    assert.match(failure ?? "", /nothing was changed/);
  }
  assert.deepEqual(traffic.toasts, []);
  assert.equal(traffic.reloads + traffic.refreshes, 0);
});
