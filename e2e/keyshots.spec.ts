import { test, type Page } from "@playwright/test";

// SUB-467 visual evidence: HUD open, a row wearing a chip, and the sheet's
// "Your keys" section. Not a merge gate — skipped unless invoked as
//   SHOTS=1 npx playwright test e2e/keyshots.spec.ts
// Outputs land in shots/ at the worktree root.
const OUT = "shots";

test.skip(!process.env.SHOTS, "evidence run only — SHOTS=1 enables");

async function assignOne(page: Page): Promise<void> {
  await page.keyboard.press("Meta+/");
  await page.locator(".sheet-assign-btn").click();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const chip = page.locator(".key-hud-grid .key-chip").first();
  const target = page.locator(".side-item", { hasText: "Calendar" }).first();
  await chip.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

test("shots: hud, chip on a row, cheat sheet", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item").first().waitFor();

  await assignOne(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/hud-open.png` });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.locator(".sidebar").screenshot({ path: `${OUT}/row-chip.png` });

  await page.keyboard.press("Meta+/");
  // Your keys is the last section — the sheet body scrolls, so ride it down
  await page.locator(".palette-section", { hasText: "Your keys" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator(".shortcut-sheet").screenshot({ path: `${OUT}/sheet-your-keys.png` });
});
