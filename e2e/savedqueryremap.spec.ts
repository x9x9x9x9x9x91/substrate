import { expect, test } from "./fixtures";
import { openDb, openFilter } from "./nav";

test("removing an unpopulated property cleans its saved query without a strip dialog", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  // Schema-only: none of Release's five notes gets a mood value.
  await page.locator(".db-add-btn").click();
  const propForm = page.locator(".selmenu");
  await propForm.locator(".dbprop-name").fill("mood");
  await propForm.locator(".selmenu-btn-primary").click();
  const mood = page.locator(".db-table th", { hasText: "mood" });
  await expect(mood).toHaveCount(1);

  await (await openFilter(page)).fill("mood:blue ");
  await page.locator(".db-filter-save").click();
  const name = page.locator(".db-filter .inline-edit");
  await name.fill("Blue mood");
  await name.press("Enter");
  const pin = page.locator(".side-view", { hasText: "Blue mood" });
  await expect(pin).toHaveCount(1);

  await mood.locator(".db-th-caret").click();
  await page.locator(".dots-item", { hasText: "Remove property…" }).click();
  await expect(page.locator(".dbform")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Property “mood” removed");

  // The backend cleanup is re-read into the live saved-view state: reopening
  // the pin immediately has no stale mood filter and shows the full database.
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await pin.click();
  await expect(page.locator(".db-filter-input")).toHaveCount(0);
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);
});
