import { expect, test, type Page } from "@playwright/test";

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");
}

async function openNote(page: Page, title: string) {
  // App shortcuts intentionally stay out of editable fields. A backlink opens
  // its destination with the title focused, so move focus back to app chrome
  // before invoking the palette a second time in this flow.
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill(title);
  await expect(page.locator(".palette-item.selected")).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title);
}

test("backlink and related-note rows expose native keyboard controls (SUB-352)", async ({
  page,
}) => {
  await boot(page);

  await openNote(page, "Slow Bloom EP");
  const backlink = page
    .locator(".backlinks:not(.related)")
    .getByRole("button", { name: "Welcome", exact: true });
  await expect(backlink).toBeVisible();
  expect(
    await backlink.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "BUTTON", tabIndex: 0 });
  await backlink.focus();
  await expect(backlink).toBeFocused();
  await backlink.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");

  await openNote(page, "Gero");
  const related = page.locator(".backlinks.related").getByRole("button").filter({
    hasText: "Slow Bloom EP",
  });
  await expect(related).toContainText("contact");
  expect(
    await related.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "BUTTON", tabIndex: 0 });
  await related.focus();
  await expect(related).toBeFocused();
  await related.press("Space");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Slow Bloom EP");
});

// Backlinks derive from OTHER notes' bodies, so an external edit
// over there must reach the open note's panel — pre-fix it only refreshed on
// remount, and the panel asserted a link that no longer existed until the
// note was closed and reopened.
test("an external link edit reaches the open note's backlinks panel (SUB-1217)", async ({
  page,
}) => {
  await boot(page);
  await openNote(page, "Slow Bloom EP");
  const panel = page.locator(".backlinks:not(.related)");
  await expect(panel.getByRole("button", { name: "Welcome", exact: true })).toBeVisible();

  // an editor outside the app rewrites Welcome without its wikilinks; the
  // watcher reports the change naming that path — not the open note's
  await page.evaluate(() => {
    window.__mockEditNote("Welcome.md", "All the links are gone now.\n");
    window.__mockEmit?.("vault:changed", ["Welcome.md"]);
  });
  await expect(panel.getByRole("button", { name: "Welcome", exact: true })).toHaveCount(0);

  // additive direction: a link written elsewhere surfaces while still open
  await page.evaluate(() => {
    window.__mockEditNote("Gero.md", "Mix engineer. Now also on [[Slow Bloom EP]].\n");
    window.__mockEmit?.("vault:changed", ["Gero.md"]);
  });
  await expect(panel.getByRole("button", { name: "Gero", exact: true })).toBeVisible();
});
