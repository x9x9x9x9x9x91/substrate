import { expect, test } from "./fixtures";

// `[[target#anchor|alias]]`. The link NAMES the target — the anchor
// says where to land inside it, the alias is what you read. Before this, both
// forms resolved to nothing and created a stray note.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.locator(".cm-content").click();
});

test("an alias shows the display text and follows to the target", async ({ page }) => {
  await page.keyboard.type("See [[Welcome|the tour]] first.\n\nnext line");
  // off the cursor's line the link reads as prose: no target, no pipe
  const link = page.locator(".cm-wikilink", { hasText: "the tour" });
  await expect(link).toHaveText("the tour");
  await expect(page.locator(".cm-wikilink", { hasText: "Welcome|" })).toHaveCount(0);
  await link.click({ modifiers: ["Meta"] });
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
});

test("an anchor follows to the note and lands on the heading", async ({ page }) => {
  await page.keyboard.type("See [[Welcome#Checklists and tables]].\n\nnext line");
  await page
    .locator(".cm-wikilink", { hasText: "Welcome#Checklists and tables" })
    .click({ modifiers: ["Meta"] });
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  // the reveal channel flashes the line it jumped to — the heading itself
  await expect(page.locator(".cm-flash-line")).toContainText("Checklists and tables");
});

test("both together: alias reads, anchor lands", async ({ page }) => {
  await page.keyboard.type("See [[Welcome#The basics|start here]].\n\nnext line");
  const link = page.locator(".cm-wikilink", { hasText: "start here" });
  await expect(link).toHaveText("start here");
  await link.click({ modifiers: ["Meta"] });
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".cm-flash-line")).toContainText("The basics");
});
