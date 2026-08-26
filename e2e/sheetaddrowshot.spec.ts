import { expect, test, type Page } from "./fixtures";

// Evidence run only: the sheet grid before and after "+ row", which is the
// surface the placeholder change moves. Shot against a build WITHOUT the
// change the tapped row is a real row in the note and its computed columns
// render the 0 that coercing its blanks produces; with it the row is a
// placeholder and derives nothing, so those cells are empty.
// The app has no runtime light theme, so dark is the pass.
//   SHOTS=1 npx playwright test e2e/sheetaddrowshot.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/sheetaddrow-shots";

async function openSheet(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Holdings");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".sheet-table")).toBeVisible();
  await page.waitForTimeout(400);
}

test("shot dark: sheet grid at rest", async ({ page }) => {
  await openSheet(page);
  await page.screenshot({ path: `${dir}/sheet-grid-dark.png`, fullPage: true });
});

test("shot dark: the row + row opens", async ({ page }) => {
  await openSheet(page);
  await page.locator(".sheet-addrow button", { hasText: "+ row" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/sheet-addrow-dark.png`, fullPage: true });
});
