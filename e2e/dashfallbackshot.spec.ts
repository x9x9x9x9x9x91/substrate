import { expect, test } from "./fixtures";

// Evidence run only: the two notes this fallback pass separates — a note that
// says only `type: dashboard` (which used to open whichever board sat first
// in the dispatch chain and now gets a card naming what it could say
// instead), and a note that asks for a board by name (unchanged).
// The app has no runtime light theme; the light ground is the print pass, so
// each note is shot dark and then on the print surface.
//   SHOTS=1 npx playwright test e2e/dashfallbackshot.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/dashfallback-shots";
// SHOTS_BEFORE captures the same two notes against a build without this
// change, where the bare note is still a live APR instrument.
const before = !!process.env.SHOTS_BEFORE;

const BARE = "Dashboards/Overview.md";

const states = [
  {
    slug: "bare-dashboard",
    open: "Overview",
    async seed(page: import("@playwright/test").Page) {
      await page.evaluate((path) => {
        window.__mockEditProp?.(path, "dashboard", null);
        window.__mockEditNote?.(path, "Nothing configured here yet.\n");
      }, BARE);
    },
    ready: before ? ".dash-apr" : ".dash-alert",
  },
  {
    slug: "explicit-food",
    open: "Calories",
    async seed() {},
    ready: ".dash-apr",
  },
];

for (const state of states) {
  test(`shot dark: ${state.slug}`, async ({ page }) => {
    await page.goto("/");
    await state.seed(page);
    await page.locator(".side-item", { hasText: state.open }).click();
    await expect(page.locator(state.ready)).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/${state.slug}-dark.png`, fullPage: true });
  });

  test(`shot light (print surface): ${state.slug}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await page.goto("/");
    await state.seed(page);
    await page.locator(".side-item", { hasText: state.open }).click();
    await expect(page.locator(state.ready)).toBeVisible({ timeout: 15000 });
    const printer = page
      .locator("#root .dash-actions")
      .getByRole("button", { name: "Print", exact: true });
    test.skip((await printer.count()) === 0, "this pane has no print surface");
    await printer.click();
    await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${state.slug}-light.png`, fullPage: true });
  });
}
