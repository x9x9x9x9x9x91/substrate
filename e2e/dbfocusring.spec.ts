import { expect, test, type Locator } from "./fixtures";
import { openDb, openFilter } from "./nav";

// The database filter and draft-title inputs killed the UA focus
// ring (border:none + outline:none) with nothing in its place — a WCAG 2.1
// SC 2.4.7 failure on a near-black ground. The filter input paints the app's
// accent ring on :focus-visible. The draft title's indicator is its WRAPPER:
// the draft cell/card paints the accent outline, exists only while the input
// is focused (autofocus at birth, blur commits), and the input itself paints
// no second ring — two nested rings read as a double frame.

/** the element's outline is a solid ring in the --accent color */
async function expectAccentRing(el: Locator) {
  const ring = await el.evaluate((node) => {
    // resolve var(--accent) through a probe so the assertion survives token edits
    const probe = document.createElement("div");
    probe.style.outlineColor = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).outlineColor;
    probe.remove();
    const s = getComputedStyle(node);
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

test("the focused draft title shows one accent ring — the wrapper's (SUB-644, SUB-1397)", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  // the draft is born autofocused and a blur commits it — it is focused for
  // its whole life, so the wrapper ring is never shown unfocused
  await expect(draft).toBeFocused();
  await expectAccentRing(page.locator("tr.db-draft-tr td.db-title"));
  // and the input paints no second ring inside it
  const inner = await draft.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(inner).toBe("none");
  await draft.press("Escape");
});
