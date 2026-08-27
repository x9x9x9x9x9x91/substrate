import { expect, test } from "./fixtures";
import { openSettings } from "./settings";

// Evidence run only: the letterbox ledger's per-box facts, quiet and then
// deviated.
//   SHOTS=1 SHOT_DIR=/tmp/shots/after npx playwright test e2e/letterboxfactshots.spec.ts
// The same file runs against the pre-fix sha (SHOT_DIR=…/before), where the
// facts are one middot chain — that is the comparison. It shoots the list,
// not the sheet: the change is inside a row, and a sheet-wide shot buries it.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/letterbox-fact-shots";

test("a letterbox box's facts, quiet and deviated", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openSettings(page, "sharing");

  const list = page.locator(".letterbox-settings .letterbox-list");
  await expect(list).toBeVisible();
  await list.scrollIntoViewIfNeeded();

  // two boxes, so the shot shows the facts stacking under each other rather
  // than one row's worth of them: a standing box and a one-shot box
  await page.locator(".letterbox-settings .mcp-grant-button").click();
  await expect(page.locator(".letterbox-settings .letterbox-box")).toHaveCount(1);
  await page.locator(".letterbox-settings").getByRole("radio", { name: "One-shot" }).click();
  await page.locator(".letterbox-settings").getByRole("radio", { name: "1d" }).click();
  await page.locator(".letterbox-settings .mcp-grant-button").click();
  await expect(page.locator(".letterbox-settings .letterbox-box")).toHaveCount(2);
  await page.waitForTimeout(200);
  await list.screenshot({ path: `${dir}/letterbox-facts-quiet.png` });

  // the deviations: drops waiting, and drops the engine could not open.
  // Nothing in the demo backend produces either on its own.
  await page.evaluate(() => window.__mockLetterboxCounts?.(3, 1));
  await page.locator(".letterbox-settings .settings-section-head .settings-raw").click();
  await expect(list).toContainText("3 pending");
  await page.waitForTimeout(200);
  await list.screenshot({ path: `${dir}/letterbox-facts-deviated.png` });
});
