import { test } from "node:test";
import assert from "node:assert/strict";
import * as real from "./mockseeds.ts";
import * as stub from "./mockseeds.stub.ts";

// vite.config.ts swaps the stub in for the real fixture in every production
// build. A missing export there is not a type error at the import site — it is
// `undefined` at runtime, inside a branch the packaged app rarely walks — so
// the shape is pinned here instead. Types are covered by the stub's own
// `typeof Seeds.x` annotations; what those cannot see is a NEW export.

test("the build stub exports exactly what the fixture exports", () => {
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(real).sort());
});

test("the build stub carries no fixture data — that is the whole point", () => {
  assert.deepEqual(stub.mockNotes, []);
  assert.equal(stub.mockAssets.size, 0);
  assert.equal(stub.mockAssetMtimes.size, 0);
  assert.equal(stub.mockLooseFiles.size, 0);
  // and the real one does, or the swap would be measuring nothing
  assert.ok(real.mockNotes.length > 0);
  assert.ok(real.mockLooseFiles.size > 0);
});
