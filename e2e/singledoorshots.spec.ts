import { expect, test } from "./fixtures";
import { openDb, openFilter } from "./nav";

// Evidence run only: the two surfaces this widened — the row context
// menu and the palette's actions stage — plus the palette command row that
// now carries link-folder export. The app has no runtime light theme (see
// e2e/accentshots.spec.ts), so these are the dark ground it ships on.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/single-door";

test("shot: row context menu", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Seal note…" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/rowmenu.png` });
});

test("shot: row context menu on a database row", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator(".db-cell", { hasText: "Slow Bloom EP" }).first().click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Hide from calendar" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/rowmenu-db.png` });
});

test("shot: row context menu while the note is unlocked", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Seal note…" }).click();
  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  await page.locator(".list .row", { hasText: "Welcome" }).first().click();
  await page.getByRole("button", { name: "Unlock to peek" }).click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Lock now" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/rowmenu-unlocked.png` });
});

test("shot: palette actions stage", async ({ page }) => {
  await page.goto("/");
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Slow Bloom EP");
  await expect(page.locator(".palette-item.selected")).toContainText("Slow Bloom EP");
  await page.keyboard.press("Tab");
  await expect(page.locator(".palette-item", { hasText: "Seal note…" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/palette-actions.png` });

  // the stage is longer than its box, and the verbs this issue adds sit past
  // the fold — walk to the end so the evidence shot actually shows them
  await page.locator(".palette-item").last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/palette-actions-end.png` });
});

test("shot: palette commands with link-folder export", async ({ page }) => {
  await page.goto("/");
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
  await page.locator(".palette-input").fill("export");
  await expect(
    page.locator(".palette-item", { hasText: "Export as link folder…" })
  ).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/palette-linkfolder.png` });
});

test("shot: the open pane after a row-menu unlock", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Seal note…" }).click();
  const setup = page.getByRole("dialog", { name: "Seal “Welcome”" });
  await setup.getByLabel("Vault password", { exact: true }).fill("correct horse");
  await setup.getByLabel("Repeat vault password").fill("correct horse");
  await setup.getByRole("button", { name: "Set password & seal" }).click();
  // open it first: this is the pane that used to stay on its lock screen
  // while the menu that unlocked the note already offered "Lock now"
  await page.locator(".list .row", { hasText: "Welcome" }).first().click();
  await expect(page.getByRole("button", { name: "Unlock to peek" })).toBeVisible();
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove seal…" }).click();
  await page
    .getByRole("dialog", { name: "Unlock “Welcome”" })
    .getByRole("button", { name: "Unlock with Touch ID / Face ID" })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/pane-adopted-unlock.png` });
});
