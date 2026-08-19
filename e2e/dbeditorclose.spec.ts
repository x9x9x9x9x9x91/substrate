import { expect, test, type Page } from "@playwright/test";
import { openDb, openFilter } from "./nav";

/* Closing a database cell editor is a hand-off. The editor owns
   real DOM focus while it is open and the pane's focus effect refuses to
   touch anything meanwhile — so when the editor goes, focus has to land
   somewhere deliberate, and anything the pane was refused mid-edit has to be
   settled there rather than left armed for the next scroll to hand over.

   The rule underneath every assertion here: never move focus or the viewport
   under a user who has deliberately put focus somewhere else. */

/** the data-column index of a prop, read off the table header */
async function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

function cellOf(page: Page, title: string, at: number) {
  return page
    .locator("tr", { has: page.locator(".db-title-txt", { hasText: title }) })
    .locator("td")
    .nth(at);
}

/** what document.activeElement is, described the way the pane classifies it */
async function activeKind(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "nowhere";
    if (a.matches("[data-fc][data-fr]")) return `cell ${a.getAttribute("data-fc")}`;
    return a.className || a.tagName.toLowerCase();
  });
}

test("Escape hands focus back to the cell the editor was on (SUB-1353)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const acquired = await colIndex(page, "acquired");
  const cell = cellOf(page, "Nordvik One", acquired);
  await cell.click();
  await expect(page.locator(".selmenu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  // before the close hand-off the grid was left with its accent ring and no
  // keyboard: focus sat on <body>, so the next arrow key went nowhere
  await expect(cell).toBeFocused();

  // and it really is the grid's keyboard again, not just a ring: the arrow
  // moves the roving tab stop, which it cannot do from <body>
  await page.keyboard.press("ArrowDown");
  await expect(async () => {
    expect(await activeKind(page)).toMatch(/^cell /);
  }).toPass();
  await expect(cell).not.toBeFocused();
});

test("a keyboard commit never drops focus onto the document (SUB-1353)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const acquired = await colIndex(page, "acquired");
  const cell = cellOf(page, "Nordvik One", acquired);
  await cell.click();
  const input = page.locator(".selmenu .selmenu-input");
  await input.fill("2019");
  await input.press("Enter");
  await expect(cell).toHaveText("2019");
  // Enter commits and carries the editor to the next cell (the hop). Whether
  // it lands there or runs out of grid, focus is inside the composite —
  // never on <body>, which is what the close hand-off guarantees.
  await expect(async () => {
    const where = await activeKind(page);
    expect(where === "nowhere").toBe(false);
  }).toPass();
});

test("clicking into another control keeps that control's focus (SUB-1353)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const acquired = await colIndex(page, "acquired");
  await cellOf(page, "Nordvik One", acquired).click();
  await expect(page.locator(".selmenu")).toBeVisible();

  // the click-away commit: the editor dismisses on mousedown, one task before
  // the browser hands focus to the funnel — a restore that fired then would
  // yank it straight back off the control the user just chose
  const filter = await openFilter(page);
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await filter.click();
  await expect(filter).toBeFocused();
  // still theirs a task later, when the deferred hand-off has run
  await expect(async () => {
    expect(await activeKind(page)).toContain("db-filter-input");
  }).toPass();
});

test("a click away onto nothing gives the cell its focus back (SUB-1353)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
  const acquired = await colIndex(page, "acquired");
  const cell = cellOf(page, "Nordvik One", acquired);
  await cell.click();
  await expect(page.locator(".selmenu")).toBeVisible();

  // the table header row takes no focus of its own here — nobody claimed it,
  // so the anchoring cell is where focus belongs
  await page.locator(".list-title").click();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell).toBeFocused();
});
