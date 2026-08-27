import { expect, seedMatching, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Panes that deliberately keep their scroll position across a data
// or view change owe the selection an explicit reveal — the browser's scroll
// anchoring must never be what keeps the row painted. The
// e2e server runs with `overflow-anchor: none` for exactly that reason, so
// every reveal below is the pane's own doing.

async function focusCell(page: Page, fc: number, fr: number) {
  await page.locator('.db-table [data-fc="0"][data-fr="0"]').focus();
  for (let r = 0; r < fr; r++) await page.keyboard.press("ArrowDown");
  for (let c = 0; c < fc; c++) await page.keyboard.press("ArrowRight");
  await expect(page.locator(`.db-table [data-fc="${fc}"][data-fr="${fr}"]`)).toBeFocused();
}

test("re-sorting a windowed table keeps the focused row painted (SUB-1132)", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/?perfdb=140");
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
  await focusCell(page, 0, 90);
  const focused = page.locator(".db-table [data-fc][data-fr]:focus");
  await expect(focused).toBeInViewport();
  const path = await focused.getAttribute("data-focus-path");

  // sorting moves the row to an index nowhere near the parked scroll offset
  await page.locator(".db-table thead th").nth(1).click();
  await expect(page.locator(`.db-table [data-focus-path="${path}"]`).first()).toBeInViewport();
});

test("switching a windowed db to board keeps the focused card painted (SUB-1132)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/?perfdb=140");
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
  await focusCell(page, 0, 90);
  const path = await page
    .locator(".db-table [data-fc][data-fr]:focus")
    .getAttribute("data-focus-path");

  await page.locator('.db-layouts button[aria-label="Board"]').click();
  await expect(page.locator(`[data-focus-path="${path}"]`).first()).toBeInViewport();
});

test("refining a search keeps the selected hit painted (SUB-1132)", async ({ page }) => {
  await seedMatching(page, { folder: "Inbox", count: 200, token: "zephyr", where: "title" });
  await page.goto("/");
  await expect(page.locator(".side-item", { hasText: /^Notes/ })).toBeVisible();
  await page.keyboard.press("Meta+Shift+f");
  const input = page.locator(".search-input");
  await expect(input).toBeFocused();
  await input.fill("zephyr");
  await expect(page.locator(".search-results .selected")).toHaveCount(1);

  // the user scrolls the results by hand, leaving the selection on the top hit:
  // refining resets it to 0, which is the number it already was, so only the
  // new row set can tell the pane its selection moved
  const list = page.locator(".search-results");
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await input.fill("zephyr ");
  await expect(page.locator(".search-results .selected")).toBeInViewport();
});
