import { test } from "@playwright/test";
test.skip(!process.env.SHOTS, "evidence run only");
const variant = process.env.VARIANT || "current";
for (const name of ["Portfolio", "Label Books", "Calories"]) {
  test(`shot: ${name}`, async ({ page }) => {
    await page.goto("/");
    await page
      .locator(".side-item")
      .filter({ has: page.getByText(name, { exact: true }) })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `/tmp/dash-contrast/${variant}-${name.replace(/\s+/g, "-").toLowerCase()}.png`,
    });
  });
}
