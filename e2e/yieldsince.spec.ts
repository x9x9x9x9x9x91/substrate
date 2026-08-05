import { expect, test } from "@playwright/test";

// Yield board history + "since" context: the snapshot table walks
// back to the earliest row on demand, and the board states when tracking
// started — hero sub, toggle label, and foot all carry the series start.
// Mock Yield APR fixture: 14 rows, first 2026-07-17 10:28.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator(".side-item", { hasText: "Yield APR" }).click();
  await expect(page.locator(".dash-add")).toBeVisible();
});

test("table toggles between recent 8 and the full series", async ({ page }) => {
  const rows = page.locator(".dash-table tbody tr");
  await expect(rows).toHaveCount(8);

  const toggle = page.locator(".dash-table-toggle");
  await expect(toggle).toHaveText("Show all 14 — back to Jul 17, 10:28");
  await toggle.click();

  await expect(rows).toHaveCount(14);
  // newest-first: the earliest snapshot is the last row
  await expect(rows.last()).toContainText("Jul 17, 10:28");

  await expect(toggle).toHaveText("Show recent 8");
  await toggle.click();
  await expect(rows).toHaveCount(8);
});

test("hero sub and foot carry since + humane window", async ({ page }) => {
  await expect(page.locator(".dash-sub")).toContainText("since Jul 17, 10:28");
  const foot = page.locator(".dash-foot");
  await expect(foot).toContainText("14 snapshots since Jul 17, 10:28");
  // 10:28 → 14:18 is 3 h 50 min — never raw minutes
  await expect(foot).toContainText("3 h 50 min");
  await expect(foot).not.toContainText("230 min");
});
