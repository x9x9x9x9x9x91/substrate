import { expect, test, type Page } from "@playwright/test";

// Right-click with a live editor selection answers with the custom
// selection menu — extract into a new note, turn into (the toolbar's block
// types), copy as markdown. Without a selection the event passes through to
// the native menu (spellcheck, system copy/paste) and no custom menu shows.
// Same ContextMenu surface as the background menus.

function ctxItem(page: Page, label: string | RegExp) {
  return page.locator(".ctx-item", { hasText: label });
}

// the Welcome note's first body word: caret into the first line, Home to the
// line start, then ten shift-arrows select "Everything"
async function selectFirstWord(page: Page) {
  const line = page.locator(".cm-content .cm-line").first();
  await line.click({ position: { x: 40, y: 10 } });
  await page.keyboard.press("Home");
  for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
}

async function openWelcome(page: Page) {
  await page.goto("/");
  await page.locator(".list .row", { hasText: "Welcome" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("right-click with a selection shows the three-item selection menu", async ({ page }) => {
  await openWelcome(page);
  await selectFirstWord(page);
  // inside the selection, so the right-click doesn't collapse it
  await page
    .locator(".cm-content .cm-line")
    .first()
    .click({ button: "right", position: { x: 30, y: 10 } });
  await expect(ctxItem(page, "Extract selection into new note")).toBeVisible();
  await expect(ctxItem(page, "Turn into…")).toBeVisible();
  await expect(ctxItem(page, "Copy as Markdown")).toBeVisible();
  await expect(page.locator(".ctx-item")).toHaveCount(3);
});

test("extract spins the selection off into a note and leaves a wikilink", async ({ page }) => {
  await openWelcome(page);
  await selectFirstWord(page);
  await page
    .locator(".cm-content .cm-line")
    .first()
    .click({ button: "right", position: { x: 30, y: 10 } });
  await ctxItem(page, "Extract selection into new note").click();

  // the selection is replaced by a link to the spun-off note…
  await expect(page.locator(".cm-content")).toContainText("[[Everything]]");
  // …created beside the source note (Welcome sits at the vault root, so the
  // Notes list gains it)
  const row = page.locator(".list .row", {
    has: page.locator(".row-title", { hasText: "Everything" }),
  });
  await expect(row).toBeVisible();

  // the new note holds the selected text, nothing more
  await row.click();
  await expect(page.locator(".note-title")).toHaveValue("Everything");
  await expect(page.locator(".cm-content")).toHaveText("Everything");
});

// the clipboard read/write the copy item needs; Chromium refuses both without
// an explicit grant, so this block scopes the permission to the one test
test.describe("copy as markdown", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copies the selection's raw markdown source, marks and all", async ({ page }) => {
    await openWelcome(page);
    // a line of our own, so the assertion owns its marks: select it whole
    const line = page.locator(".cm-content .cm-line").first();
    await line.click({ position: { x: 40, y: 10 } });
    await page.keyboard.press("Home");
    await page.keyboard.type("**bold** and `code`");
    await page.keyboard.press("Home");
    for (let i = 0; i < 19; i++) await page.keyboard.press("Shift+ArrowRight");

    await line.click({ button: "right", position: { x: 30, y: 10 } });
    await ctxItem(page, "Copy as Markdown").click();
    await expect(page.locator(".ctx-overlay")).toHaveCount(0);

    // the doc already is markdown — the clipboard gets the source, not the
    // rendered text
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("**bold** and `code`");
  });
});

test("turn into… drills into the toolbar's block types", async ({ page }) => {
  await openWelcome(page);
  await selectFirstWord(page);
  await page
    .locator(".cm-content .cm-line")
    .first()
    .click({ button: "right", position: { x: 30, y: 10 } });
  await ctxItem(page, "Turn into…").click();
  // the drill-in page: the menu stays open and swaps its items
  await expect(ctxItem(page, "Back")).toBeVisible();
  await expect(ctxItem(page, "Heading 1")).toBeVisible();
  await expect(ctxItem(page, "Callout · Idea")).toBeVisible();
  await ctxItem(page, "Heading 1").click();
  // the first line takes the h1 mark (raw while the cursor's on it)
  await expect(page.locator(".cm-content .cm-line").first()).toContainText("# Everything");
});

test("right-click with no selection keeps the native menu — no custom menu", async ({ page }) => {
  await openWelcome(page);
  // a plain caret, nothing selected
  await page.locator(".cm-content .cm-line").first().click({ position: { x: 40, y: 10 } });
  await page
    .locator(".cm-content .cm-line")
    .first()
    .click({ button: "right", position: { x: 40, y: 10 } });
  await expect(page.locator(".ctx-overlay")).toHaveCount(0);
});
