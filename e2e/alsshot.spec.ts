import { test, type Page } from "@playwright/test";

// Throwaway visual check for a pool of Ableton projects on the board — the
// extracted project columns beside the audio ones, the row menu's hand-off to
// the OS, and what an ignore list added later looks like. Not a gate.
//   SHOTS=1 npx playwright test e2e/alsshot.spec.ts
//
// One ground only: the app has no runtime light theme, and the single light
// surface is the note→PDF print pass, which hides `#root` (see
// `e2e/accentshots.spec.ts`), so a database table has no light rendering to
// shoot.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR ?? "/tmp/als-shots";
const POOL = "~/Music/Album Pool";

test.use({ viewport: { width: 1400, height: 900 } });

async function mountPool(page: Page) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "Mount a folder…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-proprow .dbform-input").fill(POOL);
  await form.locator('input[placeholder="Name…"]').fill("Album Pool");
  await form.locator(".selmenu-btn-primary").click();
  await form.locator(".selmenu-btn-primary", { hasText: "Done" }).click();
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Album Pool" }).first().click();
  await page.locator(".db-table tbody tr").first().waitFor();
}

test("a pool of Ableton sets on the board", async ({ page }) => {
  await page.goto("/");
  await mountPool(page);
  await page.screenshot({ path: `${DIR}/als-columns.png` });

  const row = page.locator(".db-table tbody tr", { hasText: "Bleed Cycle.als" }).first();
  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Open file" }).waitFor();
  await page.waitForTimeout(400); // the menu fades in — shoot it settled
  await page.screenshot({ path: `${DIR}/als-rowmenu.png` });
  await page.keyboard.press("Escape");

  // an ignore list written after the first scan: the backups grey out rather
  // than vanishing, which is the state worth looking at
  await page.evaluate(() => window.__mockSetMountIgnore?.("Album Pool", ["Backup"]));
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Rescan");
  await page.locator(".palette-item", { hasText: "Rescan mounted folders" }).first().click();
  await page.locator(".db-table tbody tr.is-missing").first().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/als-ignored-greyed.png` });
});
