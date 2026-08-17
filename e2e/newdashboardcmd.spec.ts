import { test, expect } from "@playwright/test";

// "New dashboard…" — the palette's own dashboard creation path.
//
// The unit tests prove the picker offers every kind and hands App a
// [title, kind] pair; what only a live run proves is the other end of it —
// that the note App writes from that pair really opens as a dashboard of
// that kind, with the pane's own empty state carrying on from there. Before
// this command a dashboard could only be made by creating a note and
// hand-setting two frontmatter props out of the docs.

test("the palette creates a dashboard of the kind it picked", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("dashboard");
  await page.locator(".palette-item", { hasText: "New dashboard…" }).first().click();
  await page.locator(".palette-item", { hasText: "New Tasks dashboard…" }).click();
  await input.fill("Weekly Board");
  await page.locator(".palette-item", { hasText: "New dashboard “Weekly Board”" }).click();

  // the note opened, and it opened as the tasks board rather than as text
  await expect(page.locator(".dash-title")).toHaveText("Weekly Board");
  await expect(page.locator(".tasks-compose-input")).toBeVisible();
});

test("the naming stage defaults to the kind's own title", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("dashboard");
  await page.locator(".palette-item", { hasText: "New dashboard…" }).first().click();
  await page.locator(".palette-item", { hasText: "New Charts dashboard…" }).click();

  // nothing typed: the row names the title it will use before it is pressed,
  // so pressing Enter straight through is a decision rather than an accident
  await page.locator(".palette-item", { hasText: "New dashboard “Charts”" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Charts");
});

test("the kind picker opens at its own top, not the last stage's scroll", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  await page.keyboard.press("Meta+k");
  // a query whose root results run past the fold, entered from a row down
  // there: the picker used to inherit that scroll and open mid-list, with its
  // selected first kind off screen
  await page.locator(".palette-input").fill("dashboard");
  await page.locator(".palette-item", { hasText: "New dashboard…" }).first().click();

  await expect(page.locator(".palette-item").first()).toContainText("New Tasks dashboard…");
  expect(await page.locator(".palette-results").evaluate((el) => el.scrollTop)).toBe(0);
});

test("Escape from the naming stage goes back to the kind picker", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("dashboard");
  await page.locator(".palette-item", { hasText: "New dashboard…" }).first().click();
  await page.locator(".palette-item", { hasText: "New Tasks dashboard…" }).click();

  await page.keyboard.press("Escape");
  // back one stage, not out of the palette — the kinds are on screen again
  await expect(page.locator(".palette-item", { hasText: "New Tasks dashboard…" })).toBeVisible();
});
