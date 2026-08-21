import { expect, test, type Page } from "@playwright/test";

// Throwaway evidence run photographing the shortcut surfaces for review —
// not a gate.
//   SHOTS=1 npx playwright test e2e/shortcuthudshots.spec.ts
// One pass, not a light/dark pair: styles.css carries no prefers-color-scheme
// block and the app has no theme switch, so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOTS_OUT ?? "/tmp/sub1380-shots";

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

test("shot: the calendar hint fold-out", async ({ page }) => {
  await boot(page);
  await page.locator(".keyhints-chip").click();
  await expect(page.locator(".keyhints-panel")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/1-keyhints.png` });
});

test("shot: the full sheet over the calendar", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/2-sheet.png` });
  // the calendar group is where the nine-digit row lives
  const row = page.locator(".shortcut-row", { hasText: "Open nth item" });
  await row.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/3-sheet-calendar.png` });
});
