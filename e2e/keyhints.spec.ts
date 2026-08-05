import { expect, test } from "@playwright/test";

// The unified keyboard button and its contextual panel
// against the same deterministic mock backend as shortcuts.spec.ts: registry
// rows, gated by the live view; the panel's foot routes to the full sheet.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier (cold
  // open lands on Notes — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("the button folds out the panel with the list view's live rows", async ({ page }) => {
  const chip = page.locator(".keyhints-chip");
  await expect(chip).toBeVisible();
  // one affordance, not two: NotePane sheds its own kbd button
  await expect(page.locator(".note-tools .keyhints-chip")).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-label", "Keyboard shortcuts");
  await expect(page.locator(".keyhints-panel")).toHaveCount(0);

  await chip.click();
  const panel = page.locator(".keyhints-panel");
  await expect(panel).toBeVisible();
  // the cold-open auto-selection opens a note — the live editor surface leads
  // the panel (context rows first), the Today destinations ride along
  await expect(panel.locator(".shortcut-row-label").first()).toHaveText("Bold");
  await expect(panel.locator(".shortcut-row-label", { hasText: "Open today's journal" })).toBeVisible();
  await expect(panel.locator(".shortcut-row-label", { hasText: "Go to Today" })).toBeVisible();
  // no pane surface is live in a list view
  await expect(panel.locator(".shortcut-row-label", { hasText: "Jump to today" })).toHaveCount(0);
  // the footer points at the full sheet
  await expect(panel.locator(".keyhints-foot")).toHaveText("⌘/ all shortcuts");

  // clicking the button again folds it back
  await chip.click();
  await expect(page.locator(".keyhints-panel")).toHaveCount(0);
});

test("the button rides every desktop view at one coordinate", async ({ page }) => {
  const chip = page.locator(".keyhints-chip");
  const box = await chip.boundingBox();
  expect(box).not.toBeNull();

  // calendar, then a database grid — surfaces that load their own controls
  // into the top-right corner
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await expect(chip).toBeVisible();
  expect(await chip.boundingBox()).toEqual(box);

  // Today keeps its editorial header — the slot does not move for it either
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-head")).toBeVisible();
  expect(await chip.boundingBox()).toEqual(box);
});

test("the panel's foot opens the full sheet and folds the panel away", async ({ page }) => {
  const chip = page.locator(".keyhints-chip");
  await chip.click();
  await expect(page.locator(".keyhints-panel")).toBeVisible();

  await page.locator(".keyhints-foot").click();
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  await expect(page.locator(".keyhints-panel")).toHaveCount(0);
});

test("panel follows the view: the calendar surface on ⌘4", async ({ page }) => {
  await page.locator(".keyhints-chip").click();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();

  const panel = page.locator(".keyhints-panel");
  await expect(panel).toBeVisible();
  // calendar rows replaced the list rows — the today jump keeps its bare t
  const today = panel.locator(".shortcut-row", { hasText: "Jump to today" });
  await expect(today).toBeVisible();
  expect(await today.locator(".key").allInnerTexts()).toEqual(["t"]);
  await expect(panel.locator(".shortcut-row-label", { hasText: "Move focused day" })).toBeVisible();
  // hasText is a substring test — exact-match the db grid's row instead
  // ("Move focus" is a prefix of the calendar's "Move focused day")
  await expect(panel.locator(".shortcut-row-label", { hasText: /^Move focus$/ })).toHaveCount(0);
  await expect(panel.locator(".shortcut-row-label", { hasText: "Move selection down" })).toHaveCount(0);
});

test("Escape and outside click close; the open state persists across reload", async ({ page }) => {
  const chip = page.locator(".keyhints-chip");
  const panel = page.locator(".keyhints-panel");

  await chip.click();
  await expect(panel).toBeVisible();
  // a mousedown outside the chip/panel folds it away
  await page.locator(".list-title").click();
  await expect(panel).toHaveCount(0);

  // reopen — the persisted "1" survives a reload
  await chip.click();
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("substrate.keyHints"))).toBe("1");
  await page.reload();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(panel).toBeVisible();

  // Escape closes and persists the closed state too
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("substrate.keyHints"))).toBe("0");
  await page.reload();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(panel).toHaveCount(0);
});

test("mobile layout never renders the button", async ({ page }) => {
  // the runtime flag is read at mount — size the window before the load
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".mobile-nav")).toBeVisible();
  await expect(page.locator(".keyhints-chip")).toHaveCount(0);
});
