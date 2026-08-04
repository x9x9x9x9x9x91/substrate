import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// SUB-950 mockup round: one screenshot of a seeded database table view.
// The header voice (Inter vs mono --dash-label) is swapped in CSS between
// runs; SHOT_NAME picks the output file. Evidence run only.
//   SHOTS=1 SHOT_NAME=inter npx playwright test e2e/hdrvoice.spec.ts
test.skip(!process.env.SHOTS, "evidence run only — SHOTS=1 enables");

test("shot: db table header voice", async ({ page }) => {
  const name = process.env.SHOT_NAME || "shot";
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `shots/sub-950/${name}.png` });
});
