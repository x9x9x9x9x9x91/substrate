import { expect, test, type Page } from "@playwright/test";

// Embed size modifiers: `![[cover.png|300]]` caps the width,
// `|300x200` boxes the image, and every other modifier — floats included —
// is parsed and ignored rather than erroring. Sizes are CSS caps, so nothing
// is ever distorted. Runs against the deterministic mock backend.

// same boot/seed shape as filechip.spec: cold open lands on Today, one click
// to Notes; the seed waits the own-write echo window out before emitting
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

async function seedBody(page: Page, body: string) {
  await page.evaluate((b) => window.__mockEditNote("Welcome.md", b), body);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

/** the rendered image for a body carrying exactly one image embed */
async function embedImage(page: Page, body: string) {
  await seedBody(page, body);
  const img = page.locator(".cm-embed-img img");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("src", /^blob:/);
  return img;
}

test("a bare width caps the width and leaves the height free (SUB-1102)", async ({ page }) => {
  await boot(page);
  const img = await embedImage(page, "shot\n\n![[blueprint-sketch.png|300]]\n");
  // the modifier never reaches the name
  await expect(img).toHaveAttribute("alt", "blueprint-sketch.png");
  await expect(img).toHaveCSS("max-width", "300px");
  await expect(img).not.toHaveAttribute("style", /max-height/);
});

test("WxH boxes the image without distorting it (SUB-1102)", async ({ page }) => {
  await boot(page);
  const img = await embedImage(page, "shot\n\n![[blueprint-sketch.png|300x200]]\n");
  await expect(img).toHaveCSS("max-width", "300px");
  await expect(img).toHaveCSS("max-height", "200px");
  // caps, not dimensions — nothing is stretched to fit the box
  await expect(img).not.toHaveAttribute("style", /(^|[^-])width: /);
});

test("a float renders the image unsized, never an error (SUB-1102)", async ({ page }) => {
  await boot(page);
  const img = await embedImage(page, "shot\n\n![[blueprint-sketch.png|left]]\n");
  await expect(img).not.toHaveAttribute("style", /max-width/);
});

test("a garbage or absurd modifier still renders the image (SUB-1102)", async ({ page }) => {
  await boot(page);
  const junk = await embedImage(page, "shot\n\n![[blueprint-sketch.png|axb]]\n");
  await expect(junk).not.toHaveAttribute("style", /max-width/);
  // an absurd width clamps rather than blowing the layout out
  const huge = await embedImage(page, "shot\n\n![[blueprint-sketch.png|99999]]\n");
  await expect(huge).toHaveCSS("max-width", "4096px");
});
