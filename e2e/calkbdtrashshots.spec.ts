import { expect, test, type Page } from "@playwright/test";

// Throwaway evidence run photographing the ⌘⌫ chord on the calendar for
// review — not a gate.
//   SHOTS=1 npx playwright test e2e/calkbdtrashshots.spec.ts
// One pass, not a light/dark pair: styles.css carries no prefers-color-scheme
// block and the app has no theme switch, so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = "/tmp/sub1378-shots";

/** "2026-07-18" — ISO of today, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Notes → month calendar, today's cell expanded past the 3-chip cap. */
async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-more`).click();
}

test("shot: a selected event before and after the chord", async ({ page }) => {
  await boot(page);
  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  const chip = cell.locator(".cal-entry", { hasText: "Umbra listening session" });
  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await page.screenshot({ path: `${OUT}/1-selected-before.png` });

  await page.keyboard.press("Meta+Backspace");
  await expect(cell.locator(".cal-entry", { hasText: "Umbra listening session" })).toHaveCount(0);
  await expect(page.locator(".cal-peek")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/2-trashed-after.png` });
});

test("shot: a repeating occurrence surfaces the choice instead", async ({ page }) => {
  await boot(page);
  const cell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  const chip = cell.locator(".cal-entry", { hasText: "Label sync call" });
  await chip.click();
  const peek = page.locator(".cal-peek");
  await peek.locator(".cal-peek-row", { hasText: "Repeat" }).click();
  await page.locator(".selmenu-item", { hasText: "Weekly" }).click();
  await expect(peek.locator(".cal-peek-row", { hasText: "Repeat" })).toContainText("Weekly");

  await page.keyboard.press("Meta+Backspace");
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Skip this occurrence");
  await expect(menu).toContainText("Delete this and following");
  await expect(menu).toContainText("Delete all occurrences");
  // nothing left yet — the choice is the whole point
  await expect(cell.locator(".cal-entry", { hasText: "Label sync call" })).toHaveCount(1);
  await page.waitForTimeout(300); // let the menu finish fading in
  await page.screenshot({ path: `${OUT}/3-repeating-choice.png` });
});

test("shot: the hint panel advertising the chord", async ({ page }) => {
  await boot(page);
  await page.locator(".keyhints-chip").click();
  await expect(page.locator(".keyhints-panel")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/4-keyhints.png` });
});

test("shot: the same row in the full sheet", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  const row = page.locator(".shortcut-row", { hasText: "Move event to Trash" });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/5-sheet.png` });
});
