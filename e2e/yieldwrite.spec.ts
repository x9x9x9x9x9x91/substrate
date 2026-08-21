import { expect, test, type Page } from "@playwright/test";

// Yield board write failures against the mock backend's failure hook
// (window.__mockFail). Every board mutation renders optimistically
// before its write resolves, and the writes used to be fired with a bare
// `.then(onMutated)` — a rejection was unhandled, so a refused write left the
// phantom snapshot on screen reading exactly like a saved one, and the next
// successful write serialized it into the file. Now a rejection surfaces on
// the same `.dash-alert` banner the food and feed logs use, and reloads
// disk truth so the optimistic body drops.

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator(".side-item", { hasText: "Yield APR" }).click();
  await expect(page.locator(".dash-add")).toBeVisible();
}

const lastRow = (page: Page) => page.locator(".dash-table tbody tr").first(); // newest first

test("a refused snapshot write surfaces and the phantom row goes away", async ({ page }) => {
  // an unhandled rejection would fire pageerror — the old bug's signature
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await boot(page);
  await expect(lastRow(page)).toContainText("232,00 $");
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_write_body"]);
  });

  await page.locator(".dash-form input").nth(1).fill("250");
  await page.locator(".dash-add").click();

  const err = page.locator(".dash-alert");
  await expect(err).toBeVisible();
  await expect(err).toContainText("mock failure: vault_write_body");
  // disk truth reloaded: the row the board optimistically drew is gone
  await expect(lastRow(page)).toContainText("232,00 $");
  await expect(page.locator(".dash-table tbody tr", { hasText: "250,00 $" })).toHaveCount(0);

  // the hook cleared, the next add lands and clears the banner
  await page.evaluate(() => window.__mockFail.clear());
  await page.locator(".dash-form input").nth(1).fill("260");
  await page.locator(".dash-add").click();
  await expect(lastRow(page)).toContainText("260,00 $");
  await expect(err).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("a refused claim surfaces and the Accrued metric keeps disk truth", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await boot(page);
  const accrued = page.locator(".dash-metric", { hasText: "Accrued" });
  await expect(accrued).not.toContainText("claimed");
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });

  // two-click claim
  await page.locator(".dash-claim").click();
  await page.locator(".dash-claim").click();

  const err = page.locator(".dash-alert");
  await expect(err).toBeVisible();
  await expect(err).toContainText("mock failure: vault_set_prop");
  await expect(accrued).not.toContainText("claimed");

  expect(pageErrors).toEqual([]);
});
