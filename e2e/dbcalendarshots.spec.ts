import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run only: the database pane's new calendar layout, the switcher it
// joined, and the state a database with no date property lands in. The app has
// no runtime light theme, so this is the dark ground it ships on.
//   SHOTS=1 SHOTS_DIR=/tmp/1624-shots npx playwright test e2e/dbcalendarshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/dbcalendar-shots";

async function openEvents(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const row = page
    .locator(".dbmgr-row")
    .filter({ has: page.locator(".dbmgr-row-title", { hasText: /^Event$/ }) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".list-title")).toHaveText("Event");
}

test("shot: the events database before and after the calendar", async ({ page }) => {
  await openEvents(page);
  await page.locator('.db-layouts button[aria-label="Table"]').click();
  await expect(page.locator(".db-table")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/01-table.png` });

  await page.locator('.db-layouts button[aria-label="Calendar"]').click();
  await expect(page.locator(".db-calendar")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/02-calendar.png` });

  // the month the pager lands on, so the grid is seen without today's ring too
  await page.getByRole("button", { name: "Next month" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/03-calendar-next-month.png` });
});

test("shot: a database with no date property", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Gear");
  await page.locator('.db-layouts button[aria-label="Calendar"]').click();
  await expect(page.locator(".empty")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/04-no-date-prop.png` });
});
