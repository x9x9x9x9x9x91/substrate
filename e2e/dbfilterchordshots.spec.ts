import { expect, test } from "./fixtures";
import { openDb, openFilter } from "./nav";

// Evidence run only: the database pane before and after ⌘F, on the All tab, in
// a saved view's tab, and in the table and board layouts. The app has no
// runtime light theme, so these are the dark ground it ships on.
//   SHOTS=1 SHOTS_DIR=/tmp/1503-shots npx playwright test e2e/dbfilterchordshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/dbfilterchord-shots";

async function findChord(page: import("@playwright/test").Page) {
  await page.keyboard.press("ControlOrMeta+f");
}

test("shot: all tab, closed then opened by ⌘F then narrowed", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-filter-input")).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/01-all-closed.png` });

  await findChord(page);
  await expect(page.locator(".db-filter-input")).toBeFocused();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/02-all-opened.png` });

  await page.keyboard.type("status:live ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/03-all-narrowed.png` });
});

test("shot: table and board layouts", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  for (const [slug, layout] of [
    ["04-table", "Table"],
    ["05-board", "Board"],
    ["06-gallery", "Gallery"],
  ]) {
    await page.locator(`.db-layouts button[aria-label="${layout}"]`).click();
    await findChord(page);
    await expect(page.locator(".db-filter-input")).toBeFocused();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${slug}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
});

test("shot: inside a saved view's tab", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  // saving stays on the current tab; enter the pin through its own tab
  await page.locator(".db-tab", { hasText: "Live releases" }).click();
  await expect(page.locator(".db-tab.active")).toContainText("Live releases");
  // Escape's clear/close lives on the input; the tab click parked focus on
  // the tab button, so the caret goes back first
  await page.locator(".db-filter-input").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".db-filter-input")).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/07-saved-closed.png` });

  await findChord(page);
  await expect(page.locator(".db-filter-input")).toBeFocused();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/08-saved-opened.png` });
});
