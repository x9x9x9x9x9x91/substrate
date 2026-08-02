import { expect, test, type Page } from "@playwright/test";

// SUB-286: app-level rename/move of the OPEN note must wait out the pane's
// pending debounced save. Without the flush the pane's late cleanup flush
// writes to the OLD path after the mutation, the write dies silently (SUB-94)
// and the typed text never reaches disk. Both flows commit the mutation
// inside the 500ms debounce window, then force a disk re-read by switching
// notes and back.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function boot(page: Page) {
  await page.goto("/");
  // cold open lands on the Notes scratch list (Today is a destination, SUB-300)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("row-menu rename of the open note flushes the pending save first (SUB-286)", async ({
  page,
}) => {
  // type into the open note, then rename it from its row's context menu
  // inside the debounce window — without the flush the edit dies on the old
  // path
  const marker = `E2E-RENAME ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(marker);
  await row(page, "Welcome").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  const input = page.locator("input.inline-edit");
  await expect(input).toBeVisible();
  await input.fill("Renamed E2E");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Renamed E2E");

  // disk re-read via a note switch — the typed text must have survived
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await row(page, "Renamed E2E").click();
  await expect(page.locator(".note-title")).toHaveValue("Renamed E2E");
  await expect(page.locator(".cm-content")).toContainText(marker);
});

test("move-to-folder of the open note flushes the pending save first (SUB-286)", async ({
  page,
}) => {
  // type into the open note, then move it from the pane's Note actions menu
  // inside the debounce window — the text must travel with the moved file
  const marker = `E2E-MOVE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(marker);
  await page.locator('.note-tool[title="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Move to folder…" }).click();
  await expect(page.locator(".palette")).toBeVisible();
  await page.locator(".palette-item", { hasText: "Inbox" }).first().click();

  // the open pane follows the move — disk re-read via a note switch
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".cm-content")).toContainText(marker);
});
