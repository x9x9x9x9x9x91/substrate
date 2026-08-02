import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// In-cell editing (SUB-405): clicking a table cell puts the input ON the
// cell itself — typing happens in the actual box, the option list hangs
// below as a panel. Free-text kinds prefill the raw value and commit like
// an inline input; optioned kinds keep the empty filter input and ghost the
// current value as the placeholder.

/** the data-column index of a prop, read off the table header (title first) —
    headers render display-capitalized (SUB-255), so match case-insensitively */
async function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

async function boxOf(loc: ReturnType<Page["locator"]>) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
}

test("free-text cell edits in place: input on the cell rect, prefilled, Enter commits", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Inventory");

  const acquired = await colIndex(page, "acquired");
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  const cell = row.locator("td").nth(acquired);
  await expect(cell).toHaveText("2018");
  const cellBox = await boxOf(cell);
  await cell.click();

  // the editor is the cell: the input overlays the cell's exact rect — no
  // detached panel below with a second typing surface
  const menu = page.locator(".selmenu");
  await expect(menu).toHaveClass(/selmenu-cell/);
  const input = menu.locator(".selmenu-input");
  const inputBox = await boxOf(input);
  expect(Math.abs(inputBox.x - cellBox.x)).toBeLessThan(2);
  expect(Math.abs(inputBox.y - cellBox.y)).toBeLessThan(2);
  expect(Math.abs(inputBox.width - cellBox.width)).toBeLessThan(2);
  expect(Math.abs(inputBox.height - cellBox.height)).toBeLessThan(2);

  // prefilled with the raw value, selected — typing replaces like a rename
  await expect(input).toHaveValue("2018");
  const allSelected = await input.evaluate(
    (el) =>
      (el as HTMLInputElement).selectionStart === 0 &&
      (el as HTMLInputElement).selectionEnd === (el as HTMLInputElement).value.length
  );
  expect(allSelected).toBe(true);

  // Enter commits the typed text
  await input.fill("2019");
  await input.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(
    page
      .locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) })
      .locator("td")
      .nth(acquired)
  ).toHaveText("2019");
});

test("free-text cell: Escape discards, click-away commits, emptied Enter clears", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Inventory");

  const acquired = await colIndex(page, "acquired");
  const row = () =>
    page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Monocord 64" }) });
  const cell = () => row().locator("td").nth(acquired);
  await expect(cell()).toHaveText("2024");

  // Escape discards typed text — disk truth stays
  await cell().click();
  const input = page.locator(".selmenu .selmenu-input");
  await input.fill("1999");
  await input.press("Escape");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell()).toHaveText("2024");

  // click-away commits an edited value (inline-input contract)
  await cell().click();
  await input.fill("2021");
  await page.locator(".list-title").click();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell()).toHaveText("2021");

  // emptying + Enter clears the value explicitly
  await cell().click();
  await input.fill("");
  await input.press("Enter");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell()).toHaveText("");
});

test("optioned cell: input rides the cell, current value ghosts as placeholder, list hangs below", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");

  const status = await colIndex(page, "status");
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Fern Palace" }) });
  const cell = row.locator("td").nth(status);
  await expect(cell).toContainText("mastering");
  const cellBox = await boxOf(cell);
  await cell.click();

  const menu = page.locator(".selmenu");
  await expect(menu).toHaveClass(/selmenu-cell/);
  const input = menu.locator(".selmenu-input");
  const inputBox = await boxOf(input);
  expect(Math.abs(inputBox.x - cellBox.x)).toBeLessThan(2);
  expect(Math.abs(inputBox.y - cellBox.y)).toBeLessThan(2);

  // the filter input opens empty; the current value ghosts as placeholder
  // so the cell never reads blank mid-edit (DateMenu's idiom)
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "mastering");

  // options hang in a panel below the cell, current value checked
  const panel = menu.locator(".selmenu-cell-panel");
  const panelBox = await boxOf(panel);
  expect(panelBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
  await expect(
    panel.locator(".selmenu-item", { hasText: "mastering" }).locator(".selmenu-cur")
  ).toHaveCount(1);

  // picking still commits and closes
  await panel.locator(".selmenu-item", { hasText: "live" }).click();
  await expect(menu).toHaveCount(0);
  await expect(
    page
      .locator("tr", { has: page.locator(".db-title-txt", { hasText: "Fern Palace" }) })
      .locator("td")
      .nth(status)
  ).toContainText("live");
});
