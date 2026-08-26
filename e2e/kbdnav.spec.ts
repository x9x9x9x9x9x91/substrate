import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// ⌘⌫ trash, focus-follows-selection, and ⌫ back-navigation against
// the deterministic mock backend. Fresh page = fresh vault per test.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function bootNotes(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("⌘⌫ trashes the selected note with an Undo toast (SUB-392)", async ({ page }) => {
  await bootNotes(page);
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  // focus sits on the clicked row — a real list surface, not a text edit
  await page.keyboard.press("Meta+Backspace");

  const toast = page.locator(".toast");
  await expect(toast).toContainText("Moved to Trash");
  await expect(row(page, "Capture anything")).toHaveCount(0);

  // Undo restores the note
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(row(page, "Capture anything")).toBeVisible();
});

test("⌘⌫ mid-typing deletes text, never the note (SUB-392)", async ({ page }) => {
  await bootNotes(page);
  const rows = await page.locator(".list .row").count();
  const title = page.locator(".note-title");
  await title.click();
  await title.press("End");
  await page.keyboard.press("Meta+Backspace");
  // Cocoa delete-to-line-start cleared the field; nothing was trashed
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.locator(".list .row")).toHaveCount(rows);
});

test("focus ring follows arrow-key selection; Enter opens the note (SUB-392)", async ({ page }) => {
  await bootNotes(page);
  const first = page.locator(".list .row").first();
  await first.click();
  await expect(first).toBeFocused();

  await page.keyboard.press("ArrowDown");
  const second = page.locator(".list .row").nth(1);
  await expect(second).toHaveClass(/selected/);
  // the blue :focus-visible box moves with the selection — no stale ring
  await expect(second).toBeFocused();
  await expect(first).not.toBeFocused();

  // Enter lands in the editor of the SELECTED note, not the stale row
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
});

test("⌫ walks back: folder → database → ⌫ → folder → ⌫ → start (SUB-392)", async ({ page }) => {
  await bootNotes(page);
  // Notes → All notes → Contact db (via the manager) builds real history
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await openDb(page, "Contact");

  await page.keyboard.press("Backspace");
  // back over the manager stop to All databases
  await expect(page.locator(".list-title")).toHaveText("All databases");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  // history spent: another ⌫ is inert, the view stays
  await page.keyboard.press("Backspace");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("⌫ closes an open db side note first, then leaves the view (SUB-392)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openDb(page, "Contact");
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").dblclick();
  const split = page.locator(".db-note");
  await expect(split.locator(".note-title")).toHaveValue("Gero");

  // click into neutral chrome so focus is not in the note's text edit
  await page.locator(".list-title").click();
  await page.keyboard.press("Backspace");
  await expect(split).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText("Contact");

  await page.keyboard.press("Backspace");
  await expect(page.locator(".list-title")).toHaveText("All databases");
});

test("⌘⌫ in a db view trashes the open side note (SUB-392)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openDb(page, "Contact");
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").dblclick();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");

  await page.locator(".list-title").click();
  await page.keyboard.press("Meta+Backspace");
  await expect(page.locator(".toast")).toContainText("Moved to Trash");
  await expect(page.locator(".db-note")).toHaveCount(0);
  await expect(page.locator(".db-table tbody tr", { hasText: "Gero" })).toHaveCount(0);
});

test("the cheat sheet lists the new bindings (SUB-392)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  const labels = page.locator(".shortcut-row-label");
  await expect(labels.filter({ hasText: "Move note to Trash" })).toHaveCount(1);
  await expect(labels.filter({ hasText: /^Back$/ })).toHaveCount(1);
  const trashRow = page.locator(".shortcut-row", { hasText: "Move note to Trash" });
  expect(await trashRow.locator(".key").allInnerTexts()).toEqual(["⌘⌫"]);
});
