import { expect, test } from "@playwright/test";

// The receipts peek's pointer door: a chip's hover clock glyph must open the
// peek when CLICKED — in a real browser, where the chip's full-row primary
// overlay does hit-testing. The row blankets its children with
// pointer-events: none so label clicks reach the overlay; the clock (like the
// × remove control) must be carved out of that blanket, or every click on the
// visible glyph falls through and opens the chip editor instead. jsdom
// component tests cannot see this — only a hit-tested click can.

const NOTE = "Split the stem pack";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Ideas" }).first().click();
  await page.locator(".row", { hasText: NOTE }).first().click();
  await expect(page.locator(".note-title")).toHaveValue(NOTE);
});

test("clock glyph click opens the peek, not the chip editor", async ({ page }) => {
  const chip = page.locator(".chip", { hasText: "format" });
  await chip.hover();
  await chip.locator(".chip-clock").click();

  const peek = page.locator(".receipts-peek");
  await expect(peek).toBeVisible();
  await expect(page.locator(".chip-input")).toHaveCount(0);

  // rows are value · actor · relative time, newest first; the footer is
  // never blank — trimmed history names its horizon and links note history
  await expect(peek.locator(".receipts-row").first()).toContainText("You");
  await expect(peek.locator(".receipts-foot")).toContainText(/no history before \S/);
  await expect(peek.locator(".receipts-open")).toBeVisible();
});

test("peek row click lands in the time-travel scrubber; Esc dismisses", async ({ page }) => {
  const chip = page.locator(".chip", { hasText: "format" });
  await chip.hover();
  await chip.locator(".chip-clock").click();
  const peek = page.locator(".receipts-peek");
  await expect(peek).toBeVisible();
  await peek.locator(".receipts-row").first().click();
  await expect(page.locator(".receipts-peek")).toHaveCount(0);
  await expect(page.locator(".timebar")).toBeVisible();
  await page.locator(".timebar button", { hasText: "Return to present" }).click();
  await expect(page.locator(".timebar")).toHaveCount(0);

  await chip.hover();
  await chip.locator(".chip-clock").click();
  await expect(page.locator(".receipts-peek")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".receipts-peek")).toHaveCount(0);
});
