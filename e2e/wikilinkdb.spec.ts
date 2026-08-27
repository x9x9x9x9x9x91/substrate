import { expect, test } from "./fixtures";

// Wikilink → database fallback: an unresolved [[target]] that names
// a database opens that database view (the Notion hub-page pattern) instead of
// spawning an empty note. A genuine miss still creates the note.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.locator(".cm-content").click();
});

test("[[Release]] opens the database, case-insensitively", async ({ page }) => {
  // "Release" is a database type (lowercase on disk), not any note's title
  await page.keyboard.type("See [[Release]] for the schedule.");
  await page.locator(".cm-wikilink", { hasText: "Release" }).click({ modifiers: ["Meta"] });
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-table")).toBeVisible();
});

test("a genuine miss still creates the note", async ({ page }) => {
  await page.keyboard.type("See [[Fresh Sketch Idea]].");
  await page.locator(".cm-wikilink", { hasText: "Fresh Sketch Idea" }).click({ modifiers: ["Meta"] });
  // the unresolved-link contract is creation (vault-format §links); the new
  // note lands at the vault root, visible from Notes
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".row-title", { hasText: "Fresh Sketch Idea" })).toBeVisible();
});
