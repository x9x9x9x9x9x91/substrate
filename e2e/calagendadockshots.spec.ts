import { expect, test, type Page } from "./fixtures";
import { settingsTab } from "./settings";

// Evidence run only: the surface the Upcoming dock setting moved — the
// Calendar row in the ⌘, sheet, and the calendar itself in both docks, so the
// switch and what it does can be looked at side by side. SHOTS=1 to run.
test.skip(!process.env.SHOTS, "evidence run only");
test.use({ viewport: { width: 1400, height: 900 } });

const dir = process.env.SHOT_DIR || "/tmp/sub-shots-dock";

async function openCalendar(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
}

async function openSettings(page: Page) {
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await settingsTab(page, "appearance");
}

test("the dock switch and both docks", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
  await openCalendar(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/dock-bottom.png` });

  await openSettings(page);
  await page.locator("#set-cal-agenda-rail").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/sheet-switch-off.png` });

  await page.locator("#set-cal-agenda-rail").click();
  await expect(page.locator("#set-cal-agenda-rail")).toHaveAttribute("aria-checked", "true");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/sheet-switch-on.png` });

  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-agenda.rail")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/dock-rail.png` });
});
