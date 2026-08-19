import { expect, test, type Page } from "@playwright/test";

import { openDb } from "./nav";

// Pixel regression tier. Every other spec in e2e/ asserts structure — text,
// counts, classes — so a change that keeps the DOM and wrecks the rendering
// (a dropped stylesheet, a ramp token repointed, a pane losing its padding)
// walks straight through the suite. This one compares whole rendered surfaces
// against committed PNGs.
//
// The baselines are LINUX ONLY and live under e2e/__screenshots__/linux/
// (playwright.config.ts keys the path on {platform}). Fonts, hinting and
// device pixel ratio differ enough between macOS and Linux that a shared
// baseline is noise, and the Mac captures a person judges are a different tier
// with a different job — see docs/visual-tiers.md. So on anything but Linux
// this file skips by name instead of failing or silently writing a second
// baseline set.
test.skip(
  process.platform !== "linux",
  "visual regression tier runs on Linux baselines; Mac pixel proofs are a different tier",
);

// Determinism, in three parts:
//
// 1. The clock. src/lib/mockseeds.ts dates its fixtures off Date.now() at
//    module load — calendar entries, agenda density, the rot chips — so a
//    baseline captured today disagrees with the same code tomorrow. A fixed
//    time installed before the first navigation makes the whole seed constant.
//    setFixedTime (not install()) leaves timers running, so the app still
//    boots and settles normally.
// 2. The zone. Those fixtures do local-date arithmetic, so the capture host's
//    TZ would otherwise ride into the pixels; UTC pins it.
// 3. Animations. toHaveScreenshot disables them by default and waits for two
//    identical frames, which is what makes a settled pane comparable at all.
const FIXED_TIME = new Date("2026-06-17T09:30:00Z"); // a Wednesday, mid-morning

test.use({ timezoneId: "UTC", locale: "en-US" });

// Tolerance, and why it is not the default. `threshold` is the per-pixel
// colour distance below which two pixels count as identical, and Playwright's
// default 0.2 is wide enough to hide a real regression whole. Measured on the
// Linux runner while building this tier, against one changed line — the app's
// background token nudged from #090909 to #0d0d10, a 4/255 shift repainting
// every surface that uses it:
//
//   threshold 0.2  (default) → all ten shots GREEN. The tier proves nothing
//                              about colour at this setting.
//   threshold 0.02           → still GREEN; 4/255 sits just under it.
//   threshold 0.01           → RED, ~21% of pixels flagged per surface.
//
// So 0.01 it is: it catches the smallest colour edit worth catching, and a
// grey-ramp change is exactly the regression class the structural specs are
// blind to. `maxDiffPixelRatio` then forgives a scattering of stray pixels —
// anti-aliasing drift, not a repaint, which lands three orders of magnitude
// above it.
const SHOT = { threshold: 0.01, maxDiffPixelRatio: 0.002 } as const;

async function boot(page: Page) {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
}

async function openDash(page: Page, name: string) {
  await boot(page);
  await page.locator(".side-item", { hasText: new RegExp(`^${name}$`) }).click();
  await expect(page.locator(".dash-title")).toHaveText(name);
}

test("note list and editor", async ({ page }) => {
  await boot(page);
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page).toHaveScreenshot("notes-editor.png", SHOT);
});

test("all notes list pane", async ({ page }) => {
  await boot(page);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await expect(page).toHaveScreenshot("all-notes.png", SHOT);
});

test("database manager", async ({ page }) => {
  await boot(page);
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(page.locator(".dbmgr-row").first()).toBeVisible();
  await expect(page).toHaveScreenshot("db-manager.png", SHOT);
});

test("database table view", async ({ page }) => {
  await boot(page);
  await openDb(page, "Release");
  await expect(page).toHaveScreenshot("db-table.png", SHOT);
});

test("dashboard: overview", async ({ page }) => {
  await openDash(page, "Overview");
  await expect(page).toHaveScreenshot("dash-overview.png", SHOT);
});

test("dashboard: portfolio charts", async ({ page }) => {
  await openDash(page, "Portfolio");
  await expect(page).toHaveScreenshot("dash-portfolio.png", SHOT);
});

test("dashboard: sync manager", async ({ page }) => {
  await openDash(page, "Sync");
  await expect(page).toHaveScreenshot("dash-sync.png", SHOT);
});

test("calendar month grid", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
  await expect(page).toHaveScreenshot("calendar-month.png", SHOT);
});

test("search results", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill("inbox");
  await expect(page.locator(".search-stats")).toBeVisible();
  await expect(page).toHaveScreenshot("search-results.png", SHOT);
});

// The app has no runtime light theme — the one light surface it renders is
// the print pass, where @media print remaps the dark ramp. Capturing it here
// is the cheap half of "both themes": it is the only place the light token
// set is exercised at all, and it regressed unnoticed before.
test("print surface (light ramp)", async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await openDash(page, "Overview");
  await page
    .locator("#root .dash-actions")
    .getByRole("button", { name: "Print", exact: true })
    .click();
  await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
  await page.emulateMedia({ media: "print" });
  await expect(page).toHaveScreenshot("print-light.png", SHOT);
});
