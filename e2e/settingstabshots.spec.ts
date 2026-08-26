import { expect, test, type Page } from "./fixtures";
import { SETTINGS_TABS } from "../src/lib/settingsTabs";

// Evidence run only: the ⌘, sheet, tab by tab.
//   SHOTS=1 SHOT_DIR=/tmp/sub-1395/after npx playwright test e2e/settingstabshots.spec.ts
// The same file runs against the pre-tabs sheet (SHOT_DIR=…/before, checked
// out at main) — there it finds no tab strip and shoots the one long list at
// the top and at the bottom instead, which is the thing being compared.
//
// One ground: the app has no runtime light theme, and its one light surface is
// the print pass, which hides #root outright — so the sheet has no light
// rendering to shoot.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub-1395-shots";

// the sheet's own list, so a tab added later gets shot without anyone
// remembering to widen a copy of it here
const TABS = SETTINGS_TABS.map((t) => t.id);

async function shootSheet(page: Page, name: string) {
  await page.locator(".settings-sheet").screenshot({ path: `${dir}/${name}.png` });
}

// The sideways slide, shot as the viewport rather than the sheet: the defect is
// that the sheet moves off its own backdrop, which an element shot crops away.
// Push the body as far right as it will go and shoot what the eye would see —
// on the fixed sheet it does not move at all, which is the point.
async function shootRightEdge(page: Page, name: string) {
  await page.locator(".shortcut-sheet-body").evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test("the settings sheet, per tab", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await page.waitForTimeout(400);

  const tabbed = (await page.locator(".settings-tabs").count()) > 0;
  if (!tabbed) {
    // the before run: one list, so the evidence is where it starts and where
    // it ends
    await shootSheet(page, "list-top");
    await page.locator(".shortcut-sheet-body").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);
    await shootSheet(page, "list-bottom");
    await shootRightEdge(page, "right-edge");
    return;
  }

  for (const tab of TABS) {
    await page.locator(`#settings-tab-${tab}`).click();
    await expect(page.locator(`#settings-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(300);
    await shootSheet(page, `tab-${tab}`);
  }

  // The tab-switch carry-over: leave a tall tab at its bottom, then pick
  // another. The pair is the evidence — the first shot is the sheet scrolled
  // away from its heading, the second is the tab arrived at, which opens at
  // its own top rather than wherever the last one was left.
  await page.locator("#settings-tab-terminal").click();
  await page.waitForTimeout(200);
  await page.locator(".shortcut-sheet-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shootSheet(page, "switch-left-terminal-at-its-bottom");
  await page.locator("#settings-tab-sharing").click();
  await page.waitForTimeout(300);
  await shootSheet(page, "switch-arrived-sharing-at-its-top");

  // the locale rows, which are what used to overflow, live on General
  await page.locator("#settings-tab-general").click();
  await page.waitForTimeout(300);
  await shootRightEdge(page, "right-edge");
});
