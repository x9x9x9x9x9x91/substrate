import { expect, test, type Page } from "@playwright/test";

// Moving the OPEN note into a folder outside the current view's
// scope used to leave the view behind — the selection-guard then snapped the
// editor to a DIFFERENT note and the next keystroke landed in it (the
// wrong-note editing trap). Both entry paths (palette "Move to folder…" and
// dragging the row onto a sidebar folder) route through moveNote, so both
// must follow the note to its destination. A move of a note that ISN'T open
// must still leave the view exactly where it was.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

function sideFolder(page: Page, name: string) {
  return page.locator(".side-folder", { has: page.getByText(name, { exact: true }) }).first();
}

async function boot(page: Page) {
  await page.goto("/");
  // cold open lands on the Notes scratch list (Today is a destination)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("palette move of the open note follows it out of the Notes scope (SUB-768)", async ({
  page,
}) => {
  // Projects is a real folder: filing there promotes the note out of Notes
  await page.locator('.note-tool[title="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Move to folder…" }).click();
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator(".palette-item", { hasText: /^Projects$/ }).first().click();

  // the view followed to the destination folder…
  await expect(page.locator(".list-title")).toHaveText("Projects");
  // …and the editor still holds the moved note, not a snapped-to neighbour
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(row(page, "Welcome")).toBeVisible();
});

test("dragging the open note onto a sidebar folder follows it too (SUB-768)", async ({ page }) => {
  await row(page, "Welcome").dragTo(sideFolder(page, "Projects"));

  await expect(page.locator(".list-title")).toHaveText("Projects");
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(row(page, "Welcome")).toBeVisible();
});

// The same trap one keystroke later. Undo moves the file back
// outside the pane that recorded it, so without a follow the view stays on
// the destination, `selected` names the path the note just vacated, and the
// selection-guard snaps the editor to a neighbour — the wrong-note trap the
// Fix closed for the forward move, reopened by ⌘Z.
test("⌘Z after moving the open note follows it back (SUB-1061)", async ({ page }) => {
  await row(page, "Welcome").dragTo(sideFolder(page, "Projects"));
  await expect(page.locator(".list-title")).toHaveText("Projects");
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  // out of the editor so ⌘Z is the vault's undo, not text undo
  await row(page, "Welcome").click();
  await page.keyboard.press("Meta+z");

  await expect(page.locator(".toast")).toContainText("Undid Move");
  // the view came back to Notes with the note…
  await expect(page.locator(".list-title")).toHaveText("Notes");
  // …and the editor still holds it, not a snapped-to neighbour
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(row(page, "Welcome")).toBeVisible();

  // redo files it away again, and the view follows out a second time
  await page.keyboard.press("Meta+Shift+z");
  await expect(page.locator(".list-title")).toHaveText("Projects");
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
});

test("moving a note that isn't open leaves the view alone (SUB-768)", async ({ page }) => {
  // "Welcome" stays open; a different scratch row is the one that moves
  await row(page, "Capture anything").dragTo(sideFolder(page, "Projects"));

  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
});
