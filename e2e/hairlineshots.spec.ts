import { test } from "@playwright/test";

// Throwaway evidence run for SUB-943 (sky-fade hairline) — not a gate.
//   SHOTS=1 npx playwright test e2e/hairlineshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const variant = process.env.VARIANT || "after";

for (const width of [1280, 900]) {
  test(`shot: notes @ ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `/tmp/hairline-943/${variant}-notes-${width}.png` });
  });
}

test("shot: Calories dashboard", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".side-item")
    .filter({ has: page.getByText("Calories", { exact: true }) })
    .first()
    .click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/hairline-943/${variant}-calories.png` });
});

test("shot: Trash (edge-reaching list-head)", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".side-item")
    .filter({ has: page.getByText("Trash", { exact: true }) })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `/tmp/hairline-943/${variant}-trash.png` });
});
