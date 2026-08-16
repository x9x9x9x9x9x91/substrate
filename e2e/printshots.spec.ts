import { test } from "@playwright/test";

// Throwaway evidence run for the palette's print row — not a gate.
//   SHOTS=1 npx playwright test e2e/printshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

test("shot: palette on a plain surface, no print row", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(800);
  await page.keyboard.press("Meta+p");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/1253-shots/palette-notes.png" });
  await page.locator(".palette-input").fill("print");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/1253-shots/palette-notes-print.png" });
});

test("shot: palette on a printable dashboard", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Meta+p");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/1253-shots/palette-dash.png" });
  await page.locator(".palette-input").fill("pr");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/1253-shots/palette-dash-pr.png" });
  await page.locator(".palette-input").fill("print");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/1253-shots/palette-dash-print.png" });
});
