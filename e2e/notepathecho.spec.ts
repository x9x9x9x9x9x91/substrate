import { expect, test, type Page } from "./fixtures";

/* Vault:changed names the paths it changed, so the open note only
   re-reads when it is one of them. Proven the way the pane experiences it —
   let the note diverge on disk, then fire the event for somebody ELSE's note:
   an unnarrowed pane would re-read and adopt the divergence. Then fire it for
   the open note and watch the same divergence land. */

async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test("an unrelated vault:changed does not re-read the open note", async ({ page }) => {
  await boot(page);
  const ed = page.locator(".cm-content");
  const before = (await ed.textContent()) ?? "";

  // the open note changes on disk behind the app's back
  await page.evaluate(() =>
    window.__mockEditNote!("Welcome.md", "CHANGED ON DISK — nobody told the pane.\n")
  );

  // …and an event arrives for a different note entirely
  await page.evaluate(() => window.__mockEmit!("vault:changed", ["Vessel Songs.md"]));
  // the list refresh this event triggers is async, so give the re-read that
  // shouldn't happen every chance to happen
  await page.waitForTimeout(400);
  await expect(ed).toContainText(before.trim().slice(0, 20));
  await expect(ed).not.toContainText("CHANGED ON DISK");

  // named for the open note, the same event re-reads and adopts
  await page.evaluate(() => window.__mockEmit!("vault:changed", ["Welcome.md"]));
  await expect(ed).toContainText("CHANGED ON DISK");
});

test("an unpathed vault:changed still re-reads the open note", async ({ page }) => {
  // the engine's "I lost track and rescanned" payload: nothing to
  // narrow by, so the pane keeps its old wholesale behaviour
  await boot(page);
  const ed = page.locator(".cm-content");
  await page.evaluate(() => {
    window.__mockEditNote!("Welcome.md", "RESCAN FOUND THIS.\n");
    window.__mockEmit!("vault:changed");
  });
  await expect(ed).toContainText("RESCAN FOUND THIS");
});
