import { expect, test, type Page } from "@playwright/test";

// An external edit adopted into a clean buffer used to land in the
// editor's CodeMirror undo history as a normal entry — the next ⌘Z reverted
// the adopt itself and the debounced autosave wrote the pre-adopt body back
// over the external change, silently (no conflict banner: baseRef moved with
// the adopt). The adopt is now dispatched as a non-history transaction, so
// ⌘Z right after an adopt is a no-op here (no earlier user edit to undo) and
// the external body survives on disk.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

// cold open lands on the Today surface — same boot shape as mockfail
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("⌘Z after an external-change adopt keeps the external body (SUB-287)", async ({ page }) => {
  await boot(page);
  const ed = page.locator(".cm-content");
  // an outside editor rewrites the open note; wait out the own-write echo
  // window before emitting so the adopt runs immediately
  await page.evaluate(() => window.__mockEditNote("Welcome.md", "EXTERNAL-287 external body\n"));
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
  await expect(ed).toContainText("EXTERNAL-287 external body");

  // the user reflex that used to clobber: undo right after the adopt
  await ed.click();
  await page.keyboard.press("Meta+z");
  // let any debounced autosave land (500ms, NotePane onBodyChange)
  await page.waitForTimeout(900);

  // what did disk end up with? leave (unmount flushes any pending write) and
  // come back — the body is re-read from the mock store
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(ed).toContainText("EXTERNAL-287 external body");
});
