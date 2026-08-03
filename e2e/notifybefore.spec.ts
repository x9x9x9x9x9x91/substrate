import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// lead-time reminders (SUB-842): a date-kind prop may carry `notifyBefore`,
// an extra alert that many days before the date comes due. The schema
// editor's control is date-kind ONLY, blank means off, and the write
// persists through the mock backend's normalization mirror.
// Fixture: task `due` (date kind, notify: true, no lead time) — src/lib/tauri.ts.

/** open a column's schema editor through its header caret menu */
async function editSchema(page: import("@playwright/test").Page, col: string) {
  await page.locator(".db-table th", { hasText: col }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Edit schema…" }).click();
  const editor = page.locator(".selmenu");
  await expect(editor).toBeVisible();
  return editor;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Task");
});

test("the lead-time input is date-kind only and starts blank (SUB-842)", async ({ page }) => {
  const editor = await editSchema(page, "due");
  const days = editor.locator(".selmenu-notify-days");
  await expect(days).toHaveValue("");
  await expect(days).toHaveAttribute("max", "365");
  // it rides WITH the notify checkbox, and both leave on a non-date kind
  await expect(editor.locator(".selmenu-notify input[type=checkbox]")).toBeChecked();
  await editor.locator(".selmenu-kind", { hasText: "Text" }).click();
  await expect(days).toHaveCount(0);
});

test("a saved lead time survives a reload (SUB-842)", async ({ page }) => {
  const editor = await editSchema(page, "due");
  await editor.locator(".selmenu-notify-days").fill("3");
  await editor.locator(".selmenu-btn-primary").click();
  await expect(editor).toHaveCount(0);

  // re-navigate: the write went through the backend, not just React state
  await openDb(page, "Contact");
  await openDb(page, "Task");
  const again = await editSchema(page, "due");
  await expect(again.locator(".selmenu-notify-days")).toHaveValue("3");

  // …and blanking it clears the stored value
  await again.locator(".selmenu-notify-days").fill("");
  await again.locator(".selmenu-btn-primary").click();
  await openDb(page, "Contact");
  await openDb(page, "Task");
  const cleared = await editSchema(page, "due");
  await expect(cleared.locator(".selmenu-notify-days")).toHaveValue("");
});
