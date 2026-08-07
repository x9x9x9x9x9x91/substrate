/** The first-run sheet rendered for real — a pin on what the screen LEADS
    with, not on what it computes.

    Two things are worth a test here and they are both things a refactor
    silently drops: the product mark is the first element of the sheet, and
    the title carries the headline class the type scale hangs off. Neither is
    reachable from a unit test of `onboarding.ts` — they only exist once the
    component has rendered — and both are the kind of detail that survives a
    JSX edit as a still-passing e2e run on a sheet that has quietly gone back
    to being stacked text.

    The third test is the placement judgement, pinned so it can be argued with
    rather than rediscovered: switch mode is an overlay over an app that has
    already identified itself, so the mark is first-run only.

    Rendering is cheap — the sheet reads no IPC on mount; the backend is
    mocked anyway because `ipc.ts` is imported at module scope. */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";

function props(extra: Record<string, unknown> = {}) {
  return {
    suggested: "/Users/demo/Vault",
    configPath: "~/.config/substrate/config.toml",
    onChosen: () => {},
    ...extra,
  };
}

before(async () => {
  await mockBackend();
});

test("the first-run sheet leads with the product mark", async (t) => {
  const { default: Onboarding } = await import("../components/Onboarding.tsx");
  const r = await renderComponent(t, h(Onboarding, props()));

  const mark = r.one('[data-testid="app-mark"]');
  assert.ok(mark, "the onboarding sheet renders the product mark");
  assert.equal(mark.tagName.toLowerCase(), "svg", "the mark is a vector, not a raster <img>");
  // it LEADS: nothing of the sheet's content comes before it
  assert.equal(r.one(".onboarding-sheet")?.firstElementChild, mark);
});

test("the title carries the headline class", async (t) => {
  const { default: Onboarding } = await import("../components/Onboarding.tsx");
  const r = await renderComponent(t, h(Onboarding, props()));

  const title = r.one("h1");
  assert.equal(title?.textContent, "Choose a vault");
  assert.ok(
    title?.classList.contains("onboarding-title"),
    "the headline class is what carries 24px/600 — see .onboarding-title in styles.css"
  );
});

test("switch mode stays unbranded — the app has already introduced itself", async (t) => {
  const { default: Onboarding } = await import("../components/Onboarding.tsx");
  const r = await renderComponent(t, h(Onboarding, props({ switching: true, onCancel: () => {} })));

  assert.equal(r.one('[data-testid="app-mark"]'), null);
  assert.equal(r.one("h1")?.textContent, "Switch vault");
});
