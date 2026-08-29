import { expect, test, type Page } from "./fixtures";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/db-hide npx playwright test e2e/dbhideshots.spec.ts
// Before/after: the sidebar tree with a homed database's row and
// without it, and the All databases pane with the same database plain and
// then marked hidden. The questions the self-check asks — does the tree close
// cleanly over the missing row, and is the manager's mark legible without
// shouting in a pane that is meant to stay quiet.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/db-hide";

test.use({ viewport: { width: 1400, height: 900 } });

async function shoot(page: Page, name: string) {
  // the tree sits below the dashboards list, off the visible sidebar at this
  // height — scroll it into frame so the shot shows what changed
  await page.locator(".sidebar-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  await page.locator(".sidebar").screenshot({ path: `${DIR}/${name}.png` });
}

const taskRow = (page: Page) =>
  page
    .locator(".side-folder", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ has: page.locator(".side-db-chip") });

test("sidebar and manager, before and after a database is removed", async ({ page }) => {
  await page.goto("/");
  await expect(taskRow(page)).toBeVisible();
  await shoot(page, "sidebar-before");

  await page.locator(".side-item", { hasText: "All databases" }).click();
  const mrow = page.locator(".dbmgr-row", { hasText: "Task" }).first();
  await expect(mrow).toBeVisible();
  await page.locator(".dbmgr").screenshot({ path: `${DIR}/manager-before.png` });

  await taskRow(page).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove from sidebar" }).click();
  await expect(taskRow(page)).toHaveCount(0);
  await shoot(page, "sidebar-after");

  await expect(mrow).toHaveClass(/dbmgr-row-hidden/);
  await page.locator(".dbmgr").screenshot({ path: `${DIR}/manager-after.png` });
});
