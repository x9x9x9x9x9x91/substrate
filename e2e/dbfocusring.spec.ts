import { expect, test, type Locator } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// The database filter and draft-title inputs killed the UA focus
// ring (border:none + outline:none) with nothing in its place — a WCAG 2.1
// SC 2.4.7 failure on a near-black ground. Both now paint the app's accent
// ring on :focus-visible. A text input matches :focus-visible whenever it is
// focused (Chromium's keyboard-entry heuristic), so a plain .focus() arms it.

/** the focused input's outline is a solid ring in the --accent color */
async function expectAccentRing(input: Locator) {
  const ring = await input.evaluate((el) => {
    // resolve var(--accent) through a probe so the assertion survives token edits
    const probe = document.createElement("div");
    probe.style.outlineColor = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).outlineColor;
    probe.remove();
    const s = getComputedStyle(el);
    return { w: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, accent };
  });
  expect(ring.style).toBe("solid");
  expect(parseFloat(ring.w)).toBeGreaterThan(0);
  expect(ring.color).toBe(ring.accent);
}

test("the database filter input paints the accent ring on focus (SUB-644)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const input = await openFilter(page);
  await input.focus();
  await expect(input).toBeFocused();
  await expectAccentRing(input);
});

test("the database draft title input paints the accent ring (SUB-644)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  // the draft is born autofocused and a blur commits it — it is focused for
  // its whole life, so the ring is effectively the draft's field marker
  await expect(draft).toBeFocused();
  await expectAccentRing(draft);
  await draft.press("Escape");
});
