import { expect, test } from "@playwright/test";

// SUB-394: sidebar collapse — ⌘\ (and the head/rail buttons) hide the
// sidebar so the content panes take the full width; the slim rail keeps the
// reveal affordance; the preference survives a reload.

test("⌘\\ hides the sidebar, rail button brings it back, preference persists", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();

  await page.keyboard.press("Meta+\\");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".sidebar-rail")).toBeVisible();

  // hidden state survives a reload (localStorage preference)
  await page.reload();
  await expect(page.locator(".sidebar-rail")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar-rail")).toHaveCount(0);
});

test("sidebar-head button hides too; ⌘\\ restores", async ({ page }) => {
  await page.goto("/");
  await page.locator(".sidebar-head button[aria-label='Hide sidebar']").click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.keyboard.press("Meta+\\");
  await expect(page.locator(".sidebar")).toBeVisible();
});
