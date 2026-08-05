import { expect, test, type Page } from "@playwright/test";

// Editor half: an inline `#tag` is a live thing in prose — it wears
// a mark, it opens its collection on click (folder or no folder), and typing
// `#` offers the tags the vault already has.

async function seed(page: Page, edits: { path: string; body: string }[]) {
  await page.evaluate((es) => {
    for (const e of es) window.__mockEditNote!(e.path, e.body);
  }, edits);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));
}

/** Open a loose note through the palette — the All-notes list is windowed and
    front-loaded with database blocks, so scanning it for a row is unreliable
    (same idiom as backlinks.spec.ts). */
async function open(page: Page, title: string) {
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill(title);
  await expect(page.locator(".palette-item.selected")).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title);
}

/** Rows are matched by path: Playwright's `hasText` folds case, and a row's
    prop subtext can quote another note's title. */
function row(page: Page, path: string) {
  return page.locator(`.list-body .row[data-path="${path}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("clicking an inline #tag opens that tag's collection (SUB-818)", async ({ page }) => {
  await seed(page, [
    { path: "Glass Havens.md", body: "Second pressing shipped. #demo\n" },
    { path: "Fern Palace.md", body: "Artwork proofs due Friday. #demo\n" },
    { path: "Static Bouquet.md", body: "Nothing tagged here.\n" },
  ]);
  await open(page, "Glass Havens");

  // the tag is decorated in prose, carrying the tag it names
  const tag = page.locator(".cm-tag", { hasText: "#demo" }).first();
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute("data-tag", "demo");

  // ⌘-click (the editor has focus) — a bare click there means "put the caret
  // here", the same deal wikilinks have
  await page.locator(".cm-content").click();
  await tag.click({ modifiers: ["Meta"] });

  // no folder was ever built for #demo: the collection exists anyway
  await expect(page.locator(".list-title")).toHaveText("#demo");
  await expect(page.locator(".head-kind")).toHaveText("Tag");
  const rows = page.locator(".list-body .row:not(.row-dbblock)");
  await expect(rows).toHaveCount(2);
  await expect(row(page, "Static Bouquet.md")).toHaveCount(0);
});

test("a tag collection folds case and unions prose with the tags: prop (SUB-818)", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mockEditNote!("Glass Havens.md", "Second pressing. #Demo\n");
    window.__mockEditProp!("Fern Palace.md", "tags", ["DEMO"]);
  });
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));
  await open(page, "Glass Havens");

  await page.locator(".cm-content").click();
  await page.locator(".cm-tag", { hasText: "#Demo" }).first().click({ modifiers: ["Meta"] });

  // one collection, both notes: #Demo in prose and DEMO in the prop fold together
  const rows = page.locator(".list-body .row:not(.row-dbblock)");
  await expect(rows).toHaveCount(2);
  await expect(row(page, "Glass Havens.md")).toHaveCount(1);
  await expect(row(page, "Fern Palace.md")).toHaveCount(1);
});

test("typing # offers the tags the vault already has (SUB-818)", async ({ page }) => {
  await seed(page, [
    { path: "Glass Havens.md", body: "Second pressing. #mastering\n" },
    { path: "Fern Palace.md", body: "Proofs due. #mastering #artwork\n" },
  ]);
  await open(page, "Static Bouquet");

  const ed = page.locator(".cm-content");
  await ed.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("#mas");

  const popup = page.locator(".cm-tooltip-autocomplete");
  await expect(popup.locator('li[aria-selected="true"]')).toContainText("mastering");
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");

  // completing writes the tag after the `#` it was typed behind, and the
  // finished tag decorates immediately
  await expect(ed).toContainText("#mastering");
  await expect(page.locator(".cm-tag", { hasText: "#mastering" })).toHaveCount(1);
});

test("# inside a code fence offers nothing (SUB-818)", async ({ page }) => {
  await seed(page, [{ path: "Glass Havens.md", body: "Second pressing. #mastering\n" }]);
  await open(page, "Static Bouquet");

  const ed = page.locator(".cm-content");
  await ed.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```\n#mas");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await expect(page.locator(".cm-tag")).toHaveCount(0);
});
