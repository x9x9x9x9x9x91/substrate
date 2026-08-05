import { expect, test } from "@playwright/test";

// The route to the canonical shortcut sheet plus the persistent,
// Ableton-style pointer help dock. The route moved: the app-level
// keyboard button folds out contextual hints, whose foot opens the sheet.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("the keyboard button routes to the canonical shortcut sheet", async ({ page }) => {
  const button = page.getByRole("button", { name: "Keyboard shortcuts" });
  await expect(button).toBeVisible();
  await button.click();
  await page.locator(".keyhints-foot").click();
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  await expect(page.locator(".shortcut-sheet-title")).toHaveText("Keyboard shortcuts");
});

test("info view follows the pointer and remembers its open state", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Show info view" });
  await expect(toggle).toBeVisible();
  await expect(page.locator(".info-view-panel")).toHaveCount(0);

  await toggle.click();
  const panel = page.locator(".info-view-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".info-view-title")).toHaveText("Notes");

  await page.locator(".cm-content").hover();
  await expect(panel.locator(".info-view-title")).toHaveText("Note editor");
  await expect(panel.locator(".info-view-body")).toContainText("Markdown");

  await page.getByRole("button", { name: "History" }).hover();
  await expect(panel.locator(".info-view-title")).toHaveText("Version history");
  // Moving down to read the dock must preserve the explanation.
  await panel.hover();
  await expect(panel.locator(".info-view-title")).toHaveText("Version history");

  await page.locator(".sidebar-scroll > button.side-item", { hasText: /^Calendar/ }).hover();
  await expect(panel.locator(".info-view-title")).toHaveText("Calendar");
  await expect(panel.locator(".info-view-body")).toContainText("Open this destination");

  expect(await page.evaluate(() => localStorage.getItem("substrate.infoView"))).toBe("1");
  await page.reload();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(panel).toBeVisible();

  await page.getByRole("button", { name: "Hide info view" }).click();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("substrate.infoView"))).toBe("0");
});

test("open info view follows the sidebar into the collapsed rail", async ({ page }) => {
  await page.getByRole("button", { name: "Show info view" }).click();
  await page.keyboard.press("Meta+\\");

  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".sidebar-rail")).toBeVisible();
  const panel = page.locator(".sidebar-rail .info-view-panel");
  await expect(panel).toBeVisible();

  await page.getByRole("button", { name: "Show sidebar" }).hover();
  await expect(panel.locator(".info-view-title")).toHaveText("Show sidebar");
  await expect(panel.locator(".info-view-body")).toContainText("Keyboard shortcut");
});

test("mobile omits the desktop help controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".mobile-nav")).toBeVisible();
  await expect(page.locator(".info-view-toggle")).toHaveCount(0);
  // The one keyboard button is App-level and desktop-only — the
  // note pane no longer carries a second one anywhere
  await expect(page.locator(".keyhints-chip")).toHaveCount(0);
});
