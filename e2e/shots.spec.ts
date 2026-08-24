import { test } from "@playwright/test";

// Phase-3 evidence run: full-page screenshots of every dashboard
// against the mock backend. Not a merge gate — skipped unless invoked as
//   SHOTS=1 npx playwright test e2e/shots.spec.ts
// Outputs land in /tmp/dash-shots/.
const OUT = "/tmp/dash-shots";

test.skip(!process.env.SHOTS, "evidence run only — SHOTS=1 enables");

const SIDEBAR: [string, string][] = [
  ["Portfolio", "metrics"],
  ["Overview", "charts"],
  ["Umbra Home", "hub"],
  ["Calories", "food"],
  ["News", "feed"],
  ["Music Work", "music-work"],
  ["Proxy", "proxy"],
];

for (const [label, slug] of SIDEBAR) {
  test(`shot: ${slug}`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".side-item", { hasText: label }).first().click();
    // settle: mock dashboards animate in / fetch canned state
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: false });
  });
}
