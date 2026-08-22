/** The token→literal probe, run against a real DOM through the component
    harness's jsdom globals (`componentHarness.ts` installs them at module
    scope, so the module under test is pulled in dynamically afterwards).

    What jsdom CANNOT do here is the interesting half: it does not substitute
    `var()` when it computes a style, so the resolution itself — the reason
    this helper exists — is only observable in a real engine, and that is
    pinned in the browser by `e2e/dashprint.spec.ts`, which reads the same
    tone tokens through the same trick. What IS pinned here is everything
    around it: that a token with nothing behind it yields the caller's
    fallback rather than a broken colour string, that a resolved literal is
    handed back untouched, and that the probe never survives the call. */

import assert from "node:assert/strict";
import { test } from "node:test";

import "./componentHarness.ts";

const { resolveTokenColor } = await import("./tokencolor.ts");

const FALLBACK = "rgba(255, 255, 255, 0.18)";

test("a token with nothing behind it yields the fallback, not a var() string", () => {
  // jsdom hands the unresolved reference straight back rather than dropping it
  // to the initial value — either way it is not a colour, and both shapes have
  // to end at the fallback rather than be forwarded to a colour parser
  assert.equal(resolveTokenColor("--nothing-declares-this", FALLBACK), FALLBACK);
});

test("the probe leaves no element behind", () => {
  const before = document.body.childElementCount;
  resolveTokenColor("--nothing-declares-this", FALLBACK);
  assert.equal(document.body.childElementCount, before);
});

test("a resolved literal is handed back as the engine computed it", () => {
  // jsdom stops short of var() substitution, so the engine's half is stubbed:
  // what is asserted is that a real computed colour is passed through rather
  // than discarded for the fallback
  const real = window.getComputedStyle;
  window.getComputedStyle = (() => ({ backgroundColor: "rgba(108, 192, 236, 0.22)" })) as
    unknown as typeof window.getComputedStyle;
  try {
    assert.equal(resolveTokenColor("--accent-soft", FALLBACK), "rgba(108, 192, 236, 0.22)");
  } finally {
    window.getComputedStyle = real;
  }
});

test("a fully transparent computed value counts as nothing to read", () => {
  const real = window.getComputedStyle;
  window.getComputedStyle = (() => ({ backgroundColor: "rgba(0, 0, 0, 0)" })) as
    unknown as typeof window.getComputedStyle;
  try {
    assert.equal(resolveTokenColor("--accent-soft", FALLBACK), FALLBACK);
  } finally {
    window.getComputedStyle = real;
  }
});

test("a document with no window behind it is the fallback, not a throw", () => {
  // the shape a detached/parsed document has: no defaultView to compute with
  assert.equal(resolveTokenColor("--accent-soft", FALLBACK, {} as Document), FALLBACK);
});
