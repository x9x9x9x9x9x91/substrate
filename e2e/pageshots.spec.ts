import { test } from "@playwright/test";

// Throwaway evidence run — not a gate.
test.skip(!process.env.SHOTS, "evidence run only");

const variant = process.env.VARIANT || "current";

for (const width of [1280, 760, 375]) {
  test(`shot: Coding @ ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    if (width <= 700) await page.locator(".mobile-menu").click();
    await page
      .locator(".sidebar .side-item, .side-item")
      .filter({ has: page.getByText("Coding", { exact: true }) })
      .first()
      .click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `/tmp/dash-pages/${variant}-coding-${width}.png` });
  });
}
