import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPERIMENTAL_NOTE, EXPERIMENTAL_TOGGLES } from "./experimental.ts";

test("context-bound capture is an experimental toggle, off by default", () => {
  const ctx = EXPERIMENTAL_TOGGLES.find((t) => t.key === "experimental-context-capture");
  assert.ok(ctx, "the section lost its only toggle");
  assert.equal(ctx.label, "Context-bound capture");
  // macOS-only (NSWorkspace + Accessibility), and the grant lives on the row
  assert.equal(ctx.only, "macos");
  assert.equal(ctx.needsAccessibility, true);
});

test("every experimental key is prefixed, and the section says so once", () => {
  for (const t of EXPERIMENTAL_TOGGLES) {
    assert.ok(t.key.startsWith("experimental-"), `${t.key} is not prefixed`);
    assert.ok(t.hint.trim().length > 0, `${t.key} has no hint`);
  }
  assert.match(EXPERIMENTAL_NOTE, /change or disappear/);
});
