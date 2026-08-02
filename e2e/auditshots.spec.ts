import { test } from "@playwright/test";

// Throwaway evidence run for the 2026-07-26 visual audit — not a gate.
//   SHOTS=1 npx playwright test e2e/auditshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const DASHBOARDS = [
  "Portfolio",
  "Label Books",
  "Overview",
  "Umbra Home",
  "Calories",
  "News",
  "Yield APR",
];

for (const name of DASHBOARDS) {
  test(`shot: ${name}`, async ({ page }) => {
    await page.goto("/");
    // exact: hasText is a substring match, so "Sync" also caught "Vault sync"
    // and shot the wrong pane
    await page
      .locator(".side-item")
      .filter({ has: page.getByText(name, { exact: true }) })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `/tmp/dash-audit/${name.replace(/\s+/g, "-").toLowerCase()}.png`,
      fullPage: false,
    });
  });
}
