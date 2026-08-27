import { expect, test } from "./fixtures";

// ⌘D is the daily-note hotkey, and only that. @codemirror/search's
// keymap carries its own Mod-d → selectNextOccurrence, so one press used to
// run both handlers: the app opened today's journal while CodeMirror silently
// expanded the caret to the word under it. On today's daily the editor never
// remounts, so the stray selection survived unseen and the next keystroke
// overwrote the word — a second press made it multi-range and ate every
// occurrence. Pressing ⌘D in the editor must leave the document untouched.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // cold open lands on Scratch — first paint is the "window key
  // listeners attached" barrier
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".list-title")).toHaveText("Journal");
});

test("⌘D in today's journal never selects the word under the caret", async ({ page }) => {
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.type("spectral");
  // caret inside the word, where selectNextOccurrence would grab it
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");

  // the same ⌘D again: already on today's daily, so the editor is not
  // remounted and any stray selection would persist
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".note-title-daily")).toBeVisible();
  await page.keyboard.type("Z");

  // the character was inserted at the caret; nothing was overwritten
  await expect(content).toContainText("specZtral");
});

test("a second ⌘D does not build a multi-range selection", async ({ page }) => {
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.type("drift drift");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");

  await page.keyboard.press("Meta+d");
  await page.keyboard.press("Meta+d");
  await page.keyboard.type("Z");

  // both occurrences intact — the buggy path replaced every match at once
  await expect(content).toContainText("drift drZift");
});
