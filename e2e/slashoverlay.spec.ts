import { expect, test } from "@playwright/test";

// ⌘/ opens the keyboard-shortcuts overlay. It must NEVER write to the note:
// CodeMirror's defaultKeymap binds Mod-/ to toggleComment, which silently
// inserted `<!-- -->` into the focused document while the sheet opened
// (SUB-316). The Editor filters that binding out; this spec pins both halves.

function row(page: import("@playwright/test").Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("⌘/ in the editor opens the sheet without touching the body", async ({ page }) => {
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");

  // focus INSIDE the document — the regression only fired with editor focus
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+/");

  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("<!--");

  await page.keyboard.press("Escape");
  await expect(page.locator(".shortcut-sheet")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("<!--");
});
