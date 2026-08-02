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
