import { expect, test, type Page } from "@playwright/test";

// A sheet read at an old commit is a read. Time travel already
// renders the note read-only, but the grid used to thread that only into some
// of its affordances — a cell still opened, `+ row` / `+ column` still wrote,
// and the edit landed in the live file on disk.

async function openNote(page: Page, title: string) {
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeVisible();
  await page.locator(".palette-input").fill(title);
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".note-title")).toHaveValue(title);
}

/** Open Fixed Costs, then scrub back. `snap` is the slider position, oldest
    first. The mock truncates older snapshots by line count: the oldest cuts the
    csv fence open (no grid at all) and the middle one cuts the formulas fence
    open (grid, but no computed column) — so a test that needs the whole sheet
    asks for "2". Past mode is what's under test either way. */
async function openFixedCostsInPast(page: Page, snap = "1") {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await openNote(page, "Fixed Costs");
  await expect(page.locator(".sheet-table")).toBeVisible();

  await page.getByRole("button", { name: "Browse the vault's past" }).click();
  const bar = page.getByRole("region", { name: "Vault time travel" });
  await expect(bar).toBeVisible();
  const slider = bar.getByRole("slider", { name: "Vault snapshot" });
  await expect(slider).toHaveValue("2");
  await slider.fill(snap);
  await bar.getByRole("button", { name: "View" }).click();
  await expect(page.locator(".app")).toHaveClass(/viewing-past/);
  await expect(page.locator(".sheet-table")).toBeVisible();
  return bar;
}

const dataCell = (page: Page, r: number, c: number) =>
  page.locator(".sheet-table tbody tr").nth(r).locator(".sheet-cell").nth(c);

test("a past-mode sheet opens no cell editor and writes nothing to the live file", async ({
  page,
}) => {
  await openFixedCostsInPast(page);
  const liveBody = await page.evaluate(() => window.__mockBodyOf!("Fixed Costs.md"));

  const cell = dataCell(page, 0, 1);
  const shown = await cell.innerText();
  await cell.dblclick();
  await expect(page.locator(".sheet-input")).toHaveCount(0);

  // Enter on a focused cell is the keyboard way in — same answer
  await cell.click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-input")).toHaveCount(0);
  await page.keyboard.type("MUST-NOT-LAND");
  await expect(page.locator(".sheet-input")).toHaveCount(0);
  expect(await cell.innerText()).toBe(shown);

  await page.waitForTimeout(1200); // past any debounced save
  expect(await page.evaluate(() => window.__mockBodyOf!("Fixed Costs.md"))).toBe(liveBody);
});

test("past mode hides the add affordances instead of letting them no-op", async ({ page }) => {
  await openFixedCostsInPast(page, "2"); // the whole sheet, computed column included

  await expect(page.locator(".sheet-addrow")).toHaveCount(0);
  await expect(page.locator(".sheet-addcol-btn")).toHaveCount(0);
  await expect(page.locator(".sheet-toolbar .sheet-tool", { hasText: "+ row" })).toHaveCount(0);
  await expect(page.locator(".sheet-toolbar .sheet-tool", { hasText: "+ column" })).toHaveCount(0);
  // the totals row's summary affordances stay gated too
  await expect(page.locator(".sheet-total-add")).toHaveCount(0);
  await expect(page.locator(".sheet-sum-add")).toHaveCount(0);

  // the computed-column header no longer advertises an edit, and double-click
  // opens no formula editor
  const computed = page.locator("th.sheet-computed").first();
  await expect(computed).not.toHaveAttribute("title", /double-click to edit/);
  await computed.dblclick();
  await expect(page.locator(".sheet-th-input")).toHaveCount(0);
});

test("returning to the present restores the grid's write affordances", async ({ page }) => {
  const bar = await openFixedCostsInPast(page);
  await bar.getByRole("button", { name: "Return to present" }).click();
  await expect(page.locator(".app")).not.toHaveClass(/viewing-past/);

  await expect(page.locator(".sheet-addrow")).toHaveCount(1);
  await dataCell(page, 0, 1).dblclick();
  await expect(page.locator(".sheet-input")).toHaveCount(1);
});
