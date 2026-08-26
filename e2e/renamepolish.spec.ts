import { expect, test, type Page } from "./fixtures";

// The rename lanes an earlier remount fix left open. ⌘Z of a rename and
// the sheet source view both kept the remount shape (keystroke-loss gap),
// and session folds were keyed by the editor's lagging mount identity, so
// they missed on reopen under the renamed path.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function boot(page: Page) {
  await page.goto("/");
  // cold open lands on the Notes scratch list (Today is a destination)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("⌘Z of a rename relabels the open pane in place — no remount, typing survives (SUB-783)", async ({
  page,
}) => {
  await boot(page);
  const title = page.locator(".note-title");
  await title.fill("Renamed 783");
  await page.keyboard.press("Enter");
  await expect(row(page, "Renamed 783")).toBeVisible();

  // out of the title field so ⌘Z is the vault's undo, WITHOUT changing the
  // selection — the undone rename must follow the open note, not snap away
  await page.locator(".sidebar-title").click();
  await page.locator(".cm-editor").evaluate((el) => {
    (el as HTMLElement).dataset.premount = "1";
  });
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Rename");

  // the pane followed the undo — title back, same editor DOM node, and the
  // selection stayed on this note rather than snapping to the top row
  await expect(title).toHaveValue("Welcome");
  await expect(page.locator('.cm-editor[data-premount="1"]')).toBeVisible();
  await expect(row(page, "Welcome")).toHaveClass(/selected/);

  // keystrokes right after the undo land under the note's live path
  const marker = `E2E-UNDO-RENAME ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await row(page, "Capture anything").click();
  await row(page, "Welcome").click();
  await expect(page.locator(".cm-content")).toContainText(marker);
});

test("a rename with the sheet source view open keeps the inner editor mounted (SUB-784)", async ({
  page,
}) => {
  await boot(page);
  // Holdings lives outside the scratch list — open it via the palette
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill("Holdings");
  await expect(page.locator(".palette-item.selected")).toContainText("Holdings");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await page.locator('.sheet-tool[title="View note source"]').click();
  await expect(page.locator(".sheet-src .cm-editor")).toBeVisible();
  await page.locator(".sheet-src .cm-editor").evaluate((el) => {
    (el as HTMLElement).dataset.premount = "1";
  });

  // retitle, then click straight into the source body — the capture
  // flow, one level down: the inner editor must survive the rename
  const marker = `E2E-SHEET-RENAME ${Date.now()}`;
  await page.locator(".note-title").fill("Holdings Renamed");
  await page.locator(".sheet-src .cm-content").click();
  await page.keyboard.type(marker);

  await expect(row(page, "Holdings Renamed")).toBeVisible();
  await expect(page.locator('.sheet-src .cm-editor[data-premount="1"]')).toBeVisible();
  await expect(page.locator(".sheet-src .cm-content")).toContainText(marker);

  // the typed text reached DISK under the renamed path — asserted against
  // the mock store, not a reopened view: the center-click above lands the
  // caret on the ```formulas fence delimiter line, whose raw text live
  // preview conceals when the cursor is elsewhere (e2e/sheetsource.spec.ts pins
  // that conceal/reveal behavior), so a
  // view-side text assert after reopening would fail on concealment
  await expect
    .poll(() =>
      page.evaluate(
        ([m]) => window.__mockBodyOf?.("Holdings Renamed.md")?.includes(m) ?? false,
        [marker]
      )
    )
    .toBe(true);
});

test("session folds survive a rename — looked up under the live path on reopen (SUB-785)", async ({
  page,
}) => {
  await boot(page);
  // fold "## The basics" via its gutter marker
  await page.locator(".cm-heading-fold-marker").first().click();
  await expect(page.locator(".cm-foldPlaceholder").first()).toBeVisible();

  const title = page.locator(".note-title");
  await title.fill("Welcome 785");
  await page.keyboard.press("Enter");
  await expect(row(page, "Welcome 785")).toBeVisible();

  // navigate away (unmount saves folds) and back under the NEW path — the
  // fold must be found there, not orphaned under the pre-rename identity
  await row(page, "Capture anything").click();
  await expect(title).toHaveValue("Capture anything");
  await row(page, "Welcome 785").click();
  await expect(title).toHaveValue("Welcome 785");
  await expect(page.locator(".cm-foldPlaceholder").first()).toBeVisible();
});
