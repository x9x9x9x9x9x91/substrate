import { expect, test, type Page } from "./fixtures";

// Vault sync ships notes but deliberately leaves `.assets/` behind
// (src-tauri/src/gitsync.rs:233-236), so a synced phone opens a note whose
// embeds have no files. That is the design working — it must not render as a
// broken link. Same boot/seed shape as assetheal.spec.

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo — wait the window out before emitting */
async function seedBody(page: Page, body: string) {
  await page.evaluate((b) => window.__mockEditNote("Welcome.md", b), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

async function configureSync(page: Page) {
  await page.locator(".sidebar").getByRole("button", { name: "Vault sync", exact: true }).click();
  await page.getByLabel("Remote URL").fill("https://sync.example.com/ada/vault.git");
  await page.getByLabel("Access token").fill("vault-token-444");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
}

test("an unconfigured vault keeps the broken-embed placeholder (SUB-444)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "gone\n\n![[gone.pdf]]\n\n![[gone.png]]\n");

  const missing = page.locator(".cm-embed-missing");
  await expect(missing).toHaveCount(2);
  await expect(missing.filter({ hasText: "gone.pdf" })).toContainText("missing pdf · gone.pdf");
  await expect(missing.filter({ hasText: "gone.png" })).toContainText("missing image · gone.png");
  // no sync remote → nothing could have failed to arrive
  await expect(page.locator(".cm-embed-unsynced")).toHaveCount(0);
});

test("a synced vault renders missing assets as not-on-this-device (SUB-444)", async ({ page }) => {
  await boot(page);
  await configureSync(page);
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await seedBody(page, "gone\n\n![[gone.pdf]]\n\n![[gone.png]]\n");

  const unsynced = page.locator(".cm-embed-unsynced");
  await expect(unsynced).toHaveCount(2);
  await expect(unsynced.filter({ hasText: "gone.pdf" })).toHaveText(
    "not on this device · gone.pdf"
  );
  await expect(unsynced.filter({ hasText: "gone.png" })).toHaveText(
    "not on this device · gone.png"
  );
  // still the missing family — quieter variant, not a separate widget
  await expect(page.locator(".cm-embed-missing")).toHaveCount(2);
});

test("a link-in-place path stays broken on a synced vault (SUB-444)", async ({ page }) => {
  await boot(page);
  await configureSync(page);
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await seedBody(page, "outside\n\n![[/Volumes/Studio/master.wav]]\n");

  // never lived in `.assets/`, so sync never covered it — genuinely gone
  const missing = page.locator(".cm-embed-missing");
  await expect(missing).toContainText("missing audio · /Volumes/Studio/master.wav");
  await expect(page.locator(".cm-embed-unsynced")).toHaveCount(0);
});
