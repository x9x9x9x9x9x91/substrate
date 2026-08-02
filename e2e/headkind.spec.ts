import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// SUB-400: pane headers carry a quiet kind word ("Folder" / "Database" /
// "Dashboard") next to the count — a folder of 2 notes and a database of
// 1424 entries otherwise wear identical headers. Self-describing views
// (Notes, All notes, Today…) stay unlabeled.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("folder view header says Folder", async ({ page }) => {
  await page.locator(".side-folder", { hasText: "Projects" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Projects");
  await expect(page.locator(".list-head .head-kind")).toHaveText("Folder");
});

test("database view header says Database", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".list-head .head-kind")).toHaveText("Database");
});

test("dashboard header prints no breadcrumb kicker", async ({ page }) => {
  // SUB-682: the "dashboard / <kind>" kicker SUB-409 introduced is gone —
  // design-principles lists breadcrumb kickers as an anti-pattern, and the
  // sidebar row plus the pane title already name the surface.
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await expect(page.locator(".dash-head .dash-title").first()).toBeVisible();
  await expect(page.locator(".dash-kicker")).toHaveCount(0);
});

test("self-describing views stay unlabeled", async ({ page }) => {
  await expect(page.locator(".head-kind")).toHaveCount(0);
});
