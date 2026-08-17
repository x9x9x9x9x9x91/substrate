import { expect, test } from "@playwright/test";

// The workbook tab strip's + : a page used to be addable only by hand-editing
// `pages:` in the frontmatter. Typing a database or note name appends one
// entry to the block (pages: is a list of maps, so this goes through
// vault_fm_raw / vault_fm_write, not set_prop) and switches to the new tab.
// A name that resolves to neither is refused in the field.

test("a database name becomes a view page, and the strip switches to it", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Label Books" }).click();
  await expect(page.locator(".wb-tab")).toHaveCount(4);

  await page.locator(".wb-tab-add").click();
  const field = page.locator(".wb-tabs .inline-edit");
  await field.fill("release");
  await field.press("Enter");

  const tabs = page.locator(".wb-tab");
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(4)).toHaveText("release");
  await expect(tabs.nth(4)).toHaveClass(/active/);
  // it is a real page, not an error entry
  await expect(page.locator(".wb-page-err")).toHaveCount(0);
  await expect(page.locator(".wb-view-table")).toBeVisible();
  // the pages already there are untouched
  await expect(tabs.nth(1)).toHaveText("Cash");
});

test("a note name becomes a note page, labelled the way the note is", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Label Books" }).click();

  await page.locator(".wb-tab-add").click();
  const field = page.locator(".wb-tabs .inline-edit");
  await field.fill("holdings");
  await field.press("Enter");

  // typed lowercase, but the tab carries the note's own name beside its
  // Title-Case siblings
  const added = page.locator(".wb-tab").nth(4);
  await expect(added).toHaveText("Holdings");
  await expect(added).toHaveClass(/active/);
  await expect(page.locator(".sheet")).toBeVisible();
});

// The control's promise is that a workbook never grows a page that renders as
// an error — so every case NotePage refuses is refused in the field first.
for (const [name, typed, sentence] of [
  ["a note that is neither a sheet nor a dashboard", "Slow Bloom EP", "not a sheet or dashboard"],
  ["the workbook itself", "Label Books", "own workbook"],
  ["a name that is already a page", "cash", "already a page"],
] as const) {
  test(`${name} is refused in the field`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".side-item", { hasText: "Label Books" }).click();
    await expect(page.locator(".wb-tab")).toHaveCount(4);

    await page.locator(".wb-tab-add").click();
    const field = page.locator(".wb-tabs .inline-edit");
    await field.fill(typed);
    await field.press("Enter");

    await expect(field).toHaveClass(/error/);
    await expect(page.locator(".inline-edit-error")).toContainText(sentence);
    await field.press("Escape");
    await expect(page.locator(".wb-tab")).toHaveCount(4);
  });
}

test("a name that is neither is refused in the field, nothing is written", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Label Books" }).click();

  await page.locator(".wb-tab-add").click();
  const field = page.locator(".wb-tabs .inline-edit");
  await field.fill("Nothing By That Name");
  await field.press("Enter");

  await expect(field).toHaveClass(/error/);
  await expect(page.locator(".inline-edit-error")).toContainText("No database or note");
  await field.press("Escape");
  await expect(page.locator(".wb-tab")).toHaveCount(4);
});
