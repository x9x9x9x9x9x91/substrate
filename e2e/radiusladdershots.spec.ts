import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/radius-shots npx playwright test e2e/radiusladdershots.spec.ts
//
// The committed pixel tier captures panes: lists, tables, dashboards, the
// calendar grid. None of it opens a menu, a popover, a HUD or a modal — which
// is exactly where the radius ladder and the two elevation tokens do their
// work, since those are the surfaces that carried the twelve-pixel corners and
// the fourteen hand-typed drop shadows. So this run shoots the floating half
// of the app, at the same build the baselines are recorded on, so a before and
// an after can be read side by side.
//
// Dark only, and deliberately not fullPage: a popover is judged against the
// surface it floats over, and the viewport is where it floats.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/radius-shots";

const shoot = async (page: Page, slug: string) => {
  await page.screenshot({ path: `${DIR}/${slug}.png` });
};

const home = async (page: Page) => {
  await page.goto("/");
  await page.locator(".side-item").first().waitFor();
};

test("context menu on a note row", async ({ page }) => {
  await home(page);
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "ctx-menu");
});

test("command palette", async ({ page }) => {
  await home(page);
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "palette");
});

test("shortcut sheet", async ({ page }) => {
  await home(page);
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "shortcut-sheet");
});

test("share door dialog", async ({ page }) => {
  await home(page);
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Share…").click();
  await expect(page.locator(".dbform")).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(400);
  await shoot(page, "share-door");
});

test("settings: switches, sections, inputs", async ({ page }) => {
  await home(page);
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await shoot(page, "settings");
});

test("calendar feeds menu", async ({ page }) => {
  await home(page);
  await page.locator(".side-item", { hasText: "Calendar" }).first().click();
  await expect(page.locator(".cal-grid").first()).toBeVisible({ timeout: 15000 });
  await page.locator(".cal-feeds-button").click();
  await expect(page.locator(".cal-feeds-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "calendar-feeds");
});

test("tasks board: columns, cards, chips", async ({ page }) => {
  await home(page);
  await page.locator(".side-item", { hasText: "Tasks" }).first().click();
  await expect(page.locator(".tasks-row, .tasks-col").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await shoot(page, "tasks");
});

test("view menu on a database", async ({ page }) => {
  await home(page);
  await openDb(page, "Release");
  await page.locator(".dots-btn").first().click();
  await expect(page.locator(".dots-menu")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "dots-menu");
});

test("music shelf: rows, chips, pills", async ({ page }) => {
  await home(page);
  await page.locator(".side-item", { hasText: "Listening" }).first().click();
  await expect(page.locator(".dash-inner").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await shoot(page, "listening");
});

test("sync dashboard: strip ticks, chips, capsules", async ({ page }) => {
  await home(page);
  await page.locator(".side-item", { hasText: /^Sync$/ }).first().click();
  await expect(page.locator(".dash-inner").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await shoot(page, "sync");
});
