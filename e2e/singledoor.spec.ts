import { expect, test, type Page } from "@playwright/test";
import { openDb, openFilter } from "./nav";

/* One descriptor set, every surface. Seal/lock/remove-seal and the
   calendar opt-out used to exist only on the open note's ⋯ menu, and
   link-folder export only on the saved-view sidebar menu — so which verbs a
   note had depended on where you reached for them. These drive the row context
   menu and the palette's actions stage instead. */

const ctxItem = (page: Page, label: string | RegExp) =>
  page.locator(".ctx-item", { hasText: label });

/** Right-click a note row in the vault-root list. */
async function rowMenu(page: Page, title: string) {
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page.locator(".list .row", { hasText: title }).first().click({ button: "right" });
}

/** The same row menu, from a database row — a typed note never shows up in the
    Notes list, and the table is where you meet one. */
async function dbRowMenu(page: Page, db: string, title: string) {
  await openDb(page, db);
  await page.locator(".db-cell", { hasText: title }).first().click({ button: "right" });
}

/** The palette's actions stage for a note: ⌘K, type, Tab. */
async function paletteActions(page: Page, title: string) {
  // the palette answers a keystroke, so the app has to own focus first
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill(title);
  await expect(page.locator(".palette-item.selected")).toContainText(title);
  await page.keyboard.press("Tab");
  await expect(page.locator(".palette-item").first()).toContainText("Open");
}

test("the row menu seals a note and takes the seal back off again", async ({ page }) => {
  await page.goto("/");

  await rowMenu(page, "Welcome");
  await expect(ctxItem(page, "Seal note…")).toBeVisible();
  // nothing to lock and nothing to unseal on a plaintext note
  await expect(ctxItem(page, "Lock now")).toHaveCount(0);
  await expect(ctxItem(page, "Remove seal…")).toHaveCount(0);
  await ctxItem(page, "Seal note…").click();

  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.locator(".row-sealed")).toHaveCount(1);

  // sealed and locked: the plaintext-emitting verbs are gone, and "Lock now"
  // stays away because this session holds no authorization to release
  await rowMenu(page, "Welcome");
  for (const leaky of ["Duplicate", "Export Markdown…", "Share…"]) {
    await expect(ctxItem(page, leaky)).toHaveCount(0);
  }
  await expect(ctxItem(page, "Lock now")).toHaveCount(0);

  // "Remove seal…" from here chains the two dialogs: unseal_note needs an
  // authorized identity, so it asks first and confirms after
  await ctxItem(page, "Remove seal…").click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await page
    .getByRole("dialog", { name: "Remove seal from “Welcome”" })
    .getByRole("button", { name: "Write plain Markdown" })
    .click();

  await expect(page.locator(".row-sealed")).toHaveCount(0);
  await rowMenu(page, "Welcome");
  await expect(ctxItem(page, "Seal note…")).toBeVisible();
  await expect(ctxItem(page, "Export Markdown…")).toBeVisible();
});

test("Lock now appears once the session holds the note, and locks it everywhere", async ({
  page,
}) => {
  await page.goto("/");

  await rowMenu(page, "Welcome");
  await ctxItem(page, "Seal note…").click();
  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.locator(".row-sealed")).toHaveCount(1);

  // unlock through the note pane, the way a peek happens
  await page.locator(".list .row", { hasText: "Welcome" }).first().click();
  await page.getByRole("button", { name: "Unlock to peek" }).click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  // the row menu now knows the note is readable and offers the verb
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await ctxItem(page, "Lock now").click();

  // and the open pane goes back to its lock screen rather than showing
  // plaintext the engine no longer authorizes
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();
  await expect(page.locator(".note-title")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__mockSealedUnlocked!()))
    .not.toContain("Welcome.md");
});

test("a note unlocked from the row menu opens as plaintext, not on the lock screen", async ({
  page,
}) => {
  await page.goto("/");

  await rowMenu(page, "Welcome");
  await ctxItem(page, "Seal note…").click();
  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.locator(".row-sealed")).toHaveCount(1);

  // authorize WITHOUT the pane: "Remove seal…" asks first, and escaping the
  // confirm leaves the session holding the unlock — which the row menu says
  // out loud by offering "Lock now"
  await rowMenu(page, "Welcome");
  await ctxItem(page, "Remove seal…").click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await page.getByRole("dialog", { name: "Remove seal from “Welcome”" }).waitFor();
  await page.keyboard.press("Escape");
  await rowMenu(page, "Welcome");
  await expect(ctxItem(page, "Lock now")).toBeVisible();
  await page.keyboard.press("Escape");

  // opening it now must not ask again: the pane reads the same session state
  // the row menu does, instead of keeping a private one
  await page.locator(".list .row", { hasText: "Welcome" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.getByText("Unlock to peek", { exact: true })).toHaveCount(0);

  // the pane adopted the authorization rather than taking a second one, and
  // it still returns to the lock screen when that one goes away
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await ctxItem(page, "Lock now").click();
  await expect(page.getByText("Unlock to peek", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__mockSealedUnlocked!()))
    .not.toContain("Welcome.md");
});

test("the calendar opt-out works from the row menu and from the palette", async ({ page }) => {
  await page.goto("/");

  await dbRowMenu(page, "Release", "Slow Bloom EP");
  await ctxItem(page, "Hide from calendar").click();

  // the inverse verb is what the same menu offers next
  await dbRowMenu(page, "Release", "Slow Bloom EP");
  await expect(ctxItem(page, "Show in calendar")).toBeVisible();
  await page.keyboard.press("Escape");

  // and the palette's actions stage reads the same state and flips it back
  await paletteActions(page, "Slow Bloom EP");
  // filter to the row and take it with Enter: the stage's list is long enough
  // that a click races its own scroll
  await page.locator(".palette-input").fill("Show in calendar");
  await expect(page.locator(".palette-item.selected")).toContainText("Show in calendar");
  await page.keyboard.press("Enter");

  await dbRowMenu(page, "Release", "Slow Bloom EP");
  await expect(ctxItem(page, "Hide from calendar")).toBeVisible();
});

test("the palette's actions stage carries the seal verbs too", async ({ page }) => {
  await page.goto("/");

  await paletteActions(page, "Slow Bloom EP");
  await expect(page.locator(".palette-item", { hasText: "Seal note…" })).toBeVisible();
  await page.locator(".palette-item", { hasText: "Seal note…" }).click();

  const setup = page.getByRole("dialog", { name: "Seal “Slow Bloom EP”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await expect(page.locator(".row-sealed")).toHaveCount(1);

  await paletteActions(page, "Slow Bloom EP");
  await expect(page.locator(".palette-item", { hasText: "Remove seal…" })).toBeVisible();
  await expect(page.locator(".palette-item", { hasText: "Export PDF…" })).toHaveCount(0);
});

test("link-folder export is one ⌘K away while a saved view is on screen", async ({ page }) => {
  await page.goto("/");

  // no saved view on screen: the command stays out of the way
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("link folder");
  await expect(page.locator(".palette-item", { hasText: "Export as link folder…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // seed a pin through the app's own save flow (as e2e/viewfence.spec.ts does)
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  await page.locator(".side-view", { hasText: "Live releases" }).click();

  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("link folder");
  await expect(
    page.locator(".palette-item", { hasText: "Export as link folder…" })
  ).toBeVisible();
});
