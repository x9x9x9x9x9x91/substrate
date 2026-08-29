import { expect, test } from "./fixtures";
import { settingsTab } from "./settings";
import type { Page } from "./fixtures";

// Evidence run only for the no-sync folders panel — not a gate.
//   SHOTS=1 npx playwright test e2e/syncfoldershots.spec.ts
//
// Two states are worth a picture rather than an assertion. The list is where a
// person reads what "doesn't sync" means, and the sentence under each folder is
// the whole promise — so the shot is of the wording as much as the layout. The
// refusal is the one place the panel says no, and it grows a block of file
// names inside a row that is otherwise a single line; whether that still reads
// as one row is not something a test can answer.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/syncfolder-shots";

async function openPanel(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await settingsTab(page, "vault");
  const heading = page.locator(".palette-section", { hasText: "Folders that don't sync" });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  // the rows, not just the heading: scrolling to the section title leaves the
  // whole list below the fold, and the list is what these shots are of
  await page.getByTestId("sync-folder-Notes").scrollIntoViewIfNeeded();
  return page.locator(".settings-sheet");
}

test("shot: the folder list at rest", async ({ page }) => {
  const sheet = await openPanel(page);
  await page.waitForTimeout(300);
  await sheet.screenshot({ path: `${dir}/panel-rest-dark.png` });
});

test("shot: a folder refused because its files are too large", async ({ page }) => {
  const sheet = await openPanel(page);
  await page.getByTestId("sync-folder-Samples").click();
  await expect(page.getByTestId("sync-folder-refusal")).toBeVisible();
  await page.waitForTimeout(300);
  await sheet.screenshot({ path: `${dir}/panel-refusal-dark.png` });
});

test("shot: a folder switched off", async ({ page }) => {
  const sheet = await openPanel(page);
  await page.getByTestId("sync-folder-Notes").click();
  await expect(page.getByTestId("sync-folder-Notes")).toHaveAttribute("aria-checked", "false");
  await page.waitForTimeout(300);
  await sheet.screenshot({ path: `${dir}/panel-switched-off-dark.png` });
});
