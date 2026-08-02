import { expect, test, type Page } from "@playwright/test";

// SUB-289: a missing-asset embed used to stay missing until the note
// reloaded — widget identity was name-only, so CodeMirror kept the failed DOM
// across vault epochs. Now a vault:changed re-stats exactly the failed
// widgets and heals them in place; healthy widgets compare equal and keep
// their DOM (a playing audio embed must not restart on an unrelated save).

// cold open lands on the Notes scratch list (Today is a destination, SUB-300) —
// first mock note selected and loaded (same boot shape as filechip.spec)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo (SUB-116/239) — wait the window out before emitting so the refresh
   (and its vault epoch bump) runs immediately */
async function seedBody(page: Page, body: string) {
  await page.evaluate((b) => window.__mockEditNote("Welcome.md", b), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

// 1×1 png — the same fixture pixel the mock's own image assets carry
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("missing file chip and image heal when the asset appears (SUB-289)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "gone\n\n![[gone.pdf]]\n\n![[gone.png]]\n");
  const missing = page.locator(".cm-embed-missing");
  await expect(missing).toHaveCount(2);
  await expect(missing.filter({ hasText: "gone.pdf" })).toContainText("missing file · gone.pdf");
  await expect(missing.filter({ hasText: "gone.png" })).toContainText("missing image · gone.png");

  // the assets land on disk, straight in the mock store (no app write → no
  // echo window), then the watcher fires — nothing reloads or edits the note
  await page.evaluate((png) => {
    window.__mockSaveAsset("gone.pdf", "JVBERi0xLjQKbW9jayBwZGYK");
    window.__mockSaveAsset("gone.png", png);
  }, PIXEL_PNG);
  await page.evaluate(() => window.__mockEmit("vault:changed"));

  // both widgets heal in place — no reload, no cursor pass through the source
  const chip = page.locator(".cm-filechip");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".cm-filechip-name")).toHaveText("gone.pdf");
  // the size fills in once vault_asset_info lands (mock: 8 + name.length)
  await expect(chip.locator(".cm-filechip-size")).toHaveText("16 B");
  const img = page.locator(".cm-embed-img img");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("alt", "gone.png");
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".cm-embed-missing")).toHaveCount(0);
});

test("healthy embeds keep their DOM across a vault change (SUB-289)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "mixed\n\n![[old-bounce.wav]]\n\n![[gone.pdf]]\n");
  await expect(page.locator(".cm-audio")).toBeVisible();
  await expect(page.locator(".cm-embed-missing")).toContainText("missing file · gone.pdf");

  // tag the healthy player's DOM node — a rebuild would drop the attribute
  await page.evaluate(() => {
    document.querySelector(".cm-audio")!.setAttribute("data-heal-probe", "kept");
  });
  await page.evaluate(() => window.__mockSaveAsset("gone.pdf", "JVBERi0xLjQKbW9jayBwZGYK"));
  await page.evaluate(() => window.__mockEmit("vault:changed"));

  // the failed chip heals — proof the epoch bump and decoration rebuild landed
  await expect(page.locator(".cm-filechip")).toBeVisible();
  // ...while the healthy audio widget rode the same bump untouched
  await expect(page.locator('.cm-audio[data-heal-probe="kept"]')).toBeVisible();
});
