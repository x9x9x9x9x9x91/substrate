import { expect, test, type Page } from "./fixtures";

// File chips: any embed that is neither audio nor image renders a
// named chip; click / Enter opens the file externally (the mock file_open
// logs via console.info). Runs against the deterministic mock backend (fresh
// page = fresh vault).

// cold open lands on the Today surface — one sidebar click to Notes, first
// mock note selected and loaded (same boot shape as mockfail.spec)
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* an event within 1s of an app-initiated refresh is treated as the own-write
   echo: no immediate refetch, only a trailing one at window expiry
   (App.tsx) — wait the window out before emitting so the lane under
   test runs immediately */
async function seedBody(page: Page, body: string) {
  await page.evaluate((b) => window.__mockEditNote("Welcome.md", b), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

test("audio embed renders the player, pdf embed a file chip (SUB-202)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "embeds\n\n![[old-bounce.wav]]\n\n![[some.pdf]]\n");
  await expect(page.locator(".cm-audio")).toBeVisible();
  await expect(page.locator(".cm-audio-name")).toHaveText("old-bounce.wav");
  const chip = page.locator(".cm-filechip");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".cm-filechip-name")).toHaveText("some.pdf");
  // the size fills in once vault_asset_info lands (mock: 8 + name.length)
  await expect(chip.locator(".cm-filechip-size")).toHaveText("16 B");
});

test("heic embed renders inline as an image, not a chip (SUB-281)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "photo\n\n![[IMG_0231.heic]]\n");
  const img = page.locator(".cm-embed-img img");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("alt", "IMG_0231.heic");
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".cm-filechip")).toHaveCount(0);
});

test("clicking the chip opens the file externally (SUB-202)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "chip\n\n![[some.pdf]]\n");
  const chip = page.locator(".cm-filechip");
  await expect(chip).toBeVisible();
  const opened = page.waitForEvent("console", (msg) => msg.text().includes("[mock] open"));
  await chip.click();
  expect((await opened).text()).toContain(".assets/some.pdf");
});

test("a missing target renders the missing-file state (SUB-202)", async ({ page }) => {
  await boot(page);
  await seedBody(page, "gone\n\n![[gone.pdf]]\n");
  const missing = page.locator(".cm-embed-missing");
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("missing file · gone.pdf");
});

test("pasting a non-media file attaches it and renders a chip (SUB-202)", async ({ page }) => {
  await boot(page);
  await page.locator(".cm-content").click();
  // synthetic paste carrying a real File — the intake gate must accept any
  // file type now, not just image/audio MIME (dispatch stays fully in-page:
  // drop/paste simulation through Playwright events is flaky)
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4 e2e"], "e2e-pasted.pdf", { type: "application/pdf" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  });
  const chip = page.locator(".cm-filechip");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".cm-filechip-name")).toHaveText("e2e-pasted.pdf");
});
