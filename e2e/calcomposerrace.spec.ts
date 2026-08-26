import { expect, test } from "./fixtures";
import { todayBase } from "./clock";

// An open create-composer used to swallow clicks on the same day's
// entry chips. The input committed on blur, which unmounted the composer
// between mousedown and mouseup — the cell's chips shifted up mid-click, so
// the click resolved against the day cell underneath and REOPENED the
// composer instead of opening the chip's peek (right-click → chip menu hit
// the same race). Now a press-caused blur parks the draft until the gesture
// has dispatched, so the chip keeps its geometry and the press lands where
// it was aimed. Runs against the same deterministic mock backend as
// smoke.spec.ts.

/** "2026-07-18" — ISO of today, local like dates.todayIso */
function isoDay(): string {
  const d = todayBase();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  // today's cell overflows the 3-chip month cap — expand it so every chip
  // is reachable while the composer is open
  await page.locator(`.cal-day[data-iso="${isoDay()}"] .cal-more`).click();
});

test("clicking a chip with the composer open opens its peek — and still commits the draft", async ({ page }) => {
  const today = page.locator(`.cal-day[data-iso="${isoDay()}"]`);
  await today.locator(".cal-daynum").click();
  const input = page.locator(".cal-draft-input");
  await expect(input).toBeFocused();
  await input.fill("Composer race probe");

  // ONE click on a same-day chip: the peek opens for THAT chip — no Esc
  // first, no composer reopen
  await today.locator(".cal-entry", { hasText: "Umbra listening session" }).click();
  await expect(page.locator(".cal-peek-title")).toHaveValue("Umbra listening session");
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);

  // and the half-typed draft was click-away-committed, exactly as before
  await page.keyboard.press("Escape");
  await expect(today.locator(".cal-entry", { hasText: "Composer race probe" })).toBeVisible();
});

test("right-clicking a chip with the composer open gets that chip's menu", async ({ page }) => {
  const today = page.locator(`.cal-day[data-iso="${isoDay()}"]`);
  await today.locator(".cal-daynum").click();
  await expect(page.locator(".cal-draft-input")).toBeFocused();

  await today
    .locator(".cal-entry", { hasText: "Umbra listening session" })
    .click({ button: "right" });
  // the chip's own menu — not the day cell's create/navigate menu
  await expect(page.locator(".ctx-item", { hasText: "Repeat…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);
});

test("an empty composer clicks away without creating anything", async ({ page }) => {
  const today = page.locator(`.cal-day[data-iso="${isoDay()}"]`);
  const chips = await today.locator(".cal-entry").count();
  await today.locator(".cal-daynum").click();
  await expect(page.locator(".cal-draft-input")).toBeFocused();

  await today.locator(".cal-entry", { hasText: "Umbra listening session" }).click();
  await expect(page.locator(".cal-peek-title")).toHaveValue("Umbra listening session");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-peek")).toHaveCount(0);
  await expect(today.locator(".cal-entry")).toHaveCount(chips);
});
