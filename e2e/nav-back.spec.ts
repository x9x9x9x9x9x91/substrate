import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// ⌫ has always popped the view history, but nothing on screen did —
// a mouse-driven detour into a database or a side note was a one-way trip.
// The pane header carries a back chevron whenever ⌫ would do something.

test("the header has no chevron in the view you start from", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".list-back")).toHaveCount(0);
});

test("the chevron returns from a database the way ⌫ does", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  await openDb(page, "Contact");
  const back = page.locator(".list-head .list-back");
  await expect(back).toBeVisible();

  await back.click();
  // one step back is the manager the database opened from
  await expect(page.locator(".list-title")).toHaveText("All databases");

  await back.click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".list-back")).toHaveCount(0);
});

test("the chevron closes an open entry before leaving the database", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Gero");

  // same order ⌫ walks: the side note first, then the view history
  await page.locator(".list-head .list-back").click();
  await expect(page.locator(".note-title")).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText("Contact");

  await page.locator(".list-head .list-back").click();
  await expect(page.locator(".list-title")).toHaveText("All databases");
});
