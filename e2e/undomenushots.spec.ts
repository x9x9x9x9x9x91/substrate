import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run only: the undo history popover open over a stack that has one
// live entry and one an external write staled, plus the sidebar tool row
// before the popover exists. SHOTS=1 to run (same shape as dialshots).
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub-shots-undomenu";

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

async function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

async function setRole(page: Page, title: string, value: string) {
  const role = await colIndex(page, "role");
  const cell = row(page, title).locator("td").nth(role);
  await cell.click();
  await page.locator(".selmenu .selmenu-item", { hasText: value }).click();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell).toHaveText(value);
}

test("undo history popover, one live entry and one changed on disk", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.screenshot({ path: `${dir}/undo-tools-before.png` });

  await openDb(page, "Contact");
  await setRole(page, "Noa", "booking");
  await setRole(page, "Gero", "booking");

  // somebody else rewrites the note the newest action touched, after the
  // own-write echo window so the change reads as external: ⌘Z walks past it
  await page.evaluate(() => window.__mockEditProp!("Gero.md", "role", "radio plugger"));
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed", ["Gero.md"]));
  await expect(row(page, "Gero")).toContainText("radio plugger");

  await page.locator('.side-tool-btn[aria-label="Undo history"]').click();
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".ctx-item")).toHaveCount(2);
  await expect(menu.locator(".ctx-item").first()).toContainText("changed on disk");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/undo-menu-stale.png` });
});
