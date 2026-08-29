import { test } from "node:test";
import assert from "node:assert/strict";

/* The mock backend sniffs `window` at module scope (via `isTauri`) and
   installs the e2e seam behind it — shim one before importing, the same way
   tauri.test.ts does, so the real module evaluates at all. */
(globalThis as { window?: unknown }).window = globalThis;
const real = await import("./mockBackend.ts");
const stub = await import("./mockBackend.stub.ts");

// vite.config.ts swaps the stub in for the real mock backend in every
// production build. A missing export there is not a type error at the import
// site — it is `undefined` at runtime, inside a branch the packaged app never
// walks — so the shape is pinned here instead. Types are covered by the stub's
// own `typeof Mock.x` annotations; what those cannot see is a NEW export.

test("the build stub exports exactly what the mock backend exports", () => {
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(real).sort());
});

test("the stripped bindings throw rather than quietly do nothing", async () => {
  await assert.rejects(async () => stub.mockInvoke("vault_list"), /mock backend is stripped/);
  await assert.rejects(
    async () => stub.mockListen("vault:changed", () => {}),
    /mock backend is stripped/
  );
  // and the real ones answer, or the swap would be measuring nothing
  assert.equal(typeof (await real.mockListen("vault:changed", () => {})), "function");
});
