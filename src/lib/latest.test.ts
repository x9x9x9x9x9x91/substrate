import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatestGuard } from "./latest.ts";

test("createLatestGuard: only the newest issued id is latest", () => {
  const guard = createLatestGuard();
  const a = guard.issue();
  const b = guard.issue();
  // B resolves first and applies; stale A resolving afterwards is dropped
  assert.equal(guard.isLatest(b), true);
  assert.equal(guard.isLatest(a), false);
});

test("createLatestGuard: a bare issue invalidates everything in flight", () => {
  const guard = createLatestGuard();
  const inFlight = guard.issue();
  guard.issue(); // the query was cleared while the request was out
  assert.equal(guard.isLatest(inFlight), false);
});

test("createLatestGuard: ids increase monotonically", () => {
  const guard = createLatestGuard();
  assert.equal(guard.issue(), 1);
  assert.equal(guard.issue(), 2);
  assert.equal(guard.issue(), 3);
});
