import { expect, test, type Page } from "./fixtures";

// Evidence run only: photographs the Today pane before and after a due-today
// task is finished, so the change to where a finished deadline lands can be
// looked at rather than argued about. The assertions stay loose on purpose —
// the same file is run at the old sha for the "before" pair, where the Done
// section does not exist yet.
//   SHOTS=1 npx playwright test e2e/todaydoneshots.spec.ts
// One ground: the app has no runtime light theme, so every shot is the one
// theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOT_DIR || "/tmp/today-done-shots";

async function openToday(page: Page) {
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();
}

test("shot: the day before and after a due-today task is finished", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await openToday(page);
  await expect(page.locator(".today-row").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/1-today-nothing-finished.png` });

  // the real completion path — the Tasks board's checkoff writes status: done
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await page
    .locator(".tasks-row", { hasText: "Approve SMP-030 artwork" })
    .locator(".tasks-check")
    .click();

  await openToday(page);
  await expect(
    page.locator(".today-row", { hasText: "Approve SMP-030 artwork" })
  ).toBeVisible();
  await page.screenshot({ path: `${OUT}/2-today-one-finished.png` });

  // the bottom of the column — where the finished row now sits, and where the
  // old rendering has nothing but the Picked lane
  await page.locator(".today-scroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/3-today-bottom.png` });
});
