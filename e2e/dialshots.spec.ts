import { expect, test, type Page } from "./fixtures";
import { settingsTab } from "./settings";

// Evidence run only: the Settings pane carrying the two dials, and
// the Overview + Portfolio panes at each end of the glow range and on a
// non-default tone. Same shape as accentshots.spec.ts — SHOTS=1 to run.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR || "/tmp/sub-shots-955";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));
}

async function setDials(page: Page, glow: number, tone: string) {
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await settingsTab(page, "appearance");
  await page
    .locator(".settings-row", { hasText: "Glow" })
    .locator(".settings-range")
    .fill(String(glow));
  if (tone !== "sky") {
    await page
      .locator(".settings-row", { hasText: "Accent tone" })
      .locator(`.settings-chip[data-tone-swatch="${tone}"]`)
      .click();
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
}

async function shootDash(page: Page, name: string, file: string) {
  await page.locator(".side-item", { hasText: name }).click();
  await expect(page.locator(".dash-title")).toHaveText(name);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}/${file}.png`, fullPage: true });
}

test("settings pane with the appearance dials", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  await settingsTab(page, "appearance");
  // scroll the appearance rows into view — they sit below the toggles
  await page.locator(".settings-row", { hasText: "Accent tone" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/settings-dials.png` });
});

for (const [glow, tone, tag] of [
  [0, "sky", "glow0-sky"],
  [100, "sky", "glow100-sky"],
  [0, "violet", "glow0-violet"],
  [70, "teal", "glow70-teal"],
] as const) {
  test(`dashboards: ${tag}`, async ({ page }) => {
    await boot(page);
    await setDials(page, glow, tone);
    await shootDash(page, "Overview", `overview-${tag}`);
    await shootDash(page, "Portfolio", `portfolio-${tag}`);
  });
}
