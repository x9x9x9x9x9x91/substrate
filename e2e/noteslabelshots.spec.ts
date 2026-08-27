import { expect, test, type Page } from "./fixtures";

// Evidence run only: the two fixed note destinations — the rail row and the
// pane header it opens — so the before/after of a label change is a picture
// rather than a diff. Navigation is by shortcut, never by label text, so the
// same spec runs on both sides of a rename. SHOTS=1 to run.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub-shots-1562";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
}

async function shoot(page: Page, key: string, file: string) {
  await page.keyboard.press(key);
  await expect(page.locator(".list-title")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/${file}.png` });
}

test("the rail and the pane header for the scratch destination", async ({ page }) => {
  await boot(page);
  await shoot(page, "Meta+2", "view-cmd2");
});

test("the rail and the pane header for the vault-wide destination", async ({ page }) => {
  await boot(page);
  await shoot(page, "Meta+3", "view-cmd3");
});
