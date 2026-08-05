import { expect, test, type Page } from "@playwright/test";

// Throwaway evidence run for the totals row — not a gate.
//   SHOTS=1 npx playwright test e2e/sheettotalsshots.spec.ts
// Shoots the mock's Fixed Costs sheet (thirteen named summaries) — the shape
// a real fixed-costs table has. Run it once on origin/main for the "before"
// (everything in the footer) and once on the branch for the "after" (totals
// row + slim footer).
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub937";

async function openFixedCosts(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Fixed Costs");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".sheet-table")).toBeVisible();
  await page.waitForTimeout(600);
}

test("shot: fixed-costs sheet", async ({ page }) => {
  await openFixedCosts(page);
  await page.screenshot({ path: `${dir}/sheet.png` });
});

test("shot: range selected", async ({ page }) => {
  await openFixedCosts(page);
  const cell = (r: number, c: number) =>
    page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);
  await cell(0, 1).click();
  await cell(3, 3).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/selection.png` });
});

test("shot: quick-picks on an empty totals cell", async ({ page }) => {
  await openFixedCosts(page);
  const paid = page.locator(".sheet-totals td").nth(4);
  const add = paid.locator(".sheet-total-add");
  if ((await add.count()) === 0) test.skip(true, "no totals row on this build");
  await add.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/quickpicks.png` });
});
