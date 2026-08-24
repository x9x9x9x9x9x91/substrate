import { expect, test, type Page } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// Evidence run only: the database filter row carrying a mixed query — a value
// filter, a negation and a comparison — before and after the active filters
// are read back as chips. SHOTS=1 to run.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub-shots-1504";

// One filter of each shape the grammar has, so the row shows every chip the
// overview can draw: `-key:value`, a comparison spelled across tokens, and a
// plain value filter.
const QUERY = "-format:tape released >= 2026-06-01 status:live";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
}

async function shoot(page: Page, file: string) {
  // the row settles after the query narrows the table
  await page.waitForTimeout(600);
  await page.locator(".db-filter-wrap").screenshot({ path: `${dir}/${file}-row.png` });
  await page.screenshot({ path: `${dir}/${file}-pane.png` });
}

test("the filter row under a mixed query", async ({ page }) => {
  await boot(page);
  await openDb(page, "Release");
  const input = await openFilter(page);
  await input.fill(QUERY);
  await input.press("Enter");
  await shoot(page, "filter");
});
