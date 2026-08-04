import { expect, test } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// SUB-945 design-contract cleanups: the database pane's geometry has to hold
// still while the user types or points at it. Each of these used to move
// something structural (design-principles.md 4 and 5).

test("board: the scroller survives a filter that matches nothing (SUB-945)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Board"]').click();
  const board = page.locator(".db-board");
  await expect(board).toBeVisible();
  const cols = board.locator(".db-col");
  const colCount = await cols.count();
  const firstColBefore = await cols.first().boundingBox();

  const input = await openFilter(page);
  const before = await board.boundingBox();
  await input.fill("zzzznothingmatchesthis");

  // the empty state renders inside the same scroller, which keeps its box --
  // it used to be swapped out entirely, so the board's geometry vanished and
  // came back as you typed past the last match
  await expect(board).toHaveCount(1);
  await expect(board.locator(".empty", { hasText: "No matches" })).toBeVisible();
  await expect(cols).toHaveCount(0);
  const during = await board.boundingBox();
  expect(during?.y).toBeCloseTo(before?.y ?? 0, 0);
  expect(during?.height).toBeCloseTo(before?.height ?? 0, 0);

  // and typing back to a match restores the columns in place
  await input.fill("");
  await expect(cols).toHaveCount(colCount);
  await expect(cols.first()).toBeVisible();
  const firstColAfter = await cols.first().boundingBox();
  expect(firstColAfter?.x).toBeCloseTo(firstColBefore?.x ?? 0, 0);
  expect(firstColAfter?.width).toBeCloseTo(firstColBefore?.width ?? 0, 0);
});

test("gallery: a cover enters on load once, not on a decoded remount (SUB-945)", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Gallery"]').click();

  const firstCover = page.locator(".db-gcover img").first();
  await expect(firstCover).toHaveClass(/is-loaded/);
  await expect(firstCover).toHaveClass(/cover-entering/);

  // A layout switch remounts the card, but this source is already decoded in
  // this page. It should paint immediately without replaying the entrance.
  await page.locator('.db-switch button[title="List"]').click();
  await page.locator('.db-switch button[title="Gallery"]').click();
  const remountedCover = page.locator(".db-gcover img").first();
  await expect(remountedCover).toHaveClass(/is-loaded/);
  await expect(remountedCover).not.toHaveClass(/cover-entering/);
});

test("gallery: cover entrance honors reduced motion (SUB-945)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Gallery"]').click();

  const cover = page.locator(".db-gcover img").first();
  await expect(cover).toHaveClass(/is-loaded/);
  await expect(cover).toHaveCSS("animation-name", "none");
});

test("board: per-column New reveals on hover and stays up while its draft is open (SUB-945)", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Board"]').click();

  const live = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "live" }),
  });
  const parked = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "parked" }),
  });
  const liveNew = live.locator(".db-col-new");
  const parkedNew = parked.locator(".db-col-new");

  // at rest every column's button is out of the way -- a visible button per
  // column is the anti-pattern in design-principles.md 6 -- but it still
  // holds its space, so revealing it moves nothing
  await expect(liveNew).toHaveCSS("opacity", "0");
  const restingBox = await liveNew.boundingBox();
  expect(restingBox?.height).toBeGreaterThan(0);

  await live.hover();
  await expect(liveNew).toHaveCSS("opacity", "1");
  await expect(parkedNew).toHaveCSS("opacity", "0");
  const hoveredBox = await liveNew.boundingBox();
  expect(hoveredBox?.y).toBeCloseTo(restingBox?.y ?? 0, 0);
  expect(hoveredBox?.height).toBeCloseTo(restingBox?.height ?? 0, 0);

  // opening the column's draft pins it visible: the pointer has to leave the
  // column to reach the title field, and the button must not vanish then
  await liveNew.click();
  await expect(live.locator(".db-card.db-draft")).toBeVisible();
  await parked.hover();
  await expect(liveNew).toHaveCSS("opacity", "1");
});

test("filter bar: typing never moves anything (SUB-945)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  const input = await openFilter(page);

  const save = page.locator(".db-filter-save");
  const clear = page.locator(".db-filter-clear");
  const body = page.locator(".db-body");

  // both actions are mounted before there's a query: faded out, disabled, and
  // not tab stops -- they used to mount on the first keystroke and shrink the
  // input mid-word (design-principles.md 4)
  await expect(save).toHaveCount(1);
  await expect(save).toHaveCSS("opacity", "0");
  await expect(save).toBeDisabled();
  await expect(clear).toBeDisabled();
  const inputBefore = await input.boundingBox();
  const bodyBefore = await body.boundingBox();

  await input.fill("s");
  await expect(save).toHaveCSS("opacity", "1");
  await expect(save).toBeEnabled();
  const inputAfter = await input.boundingBox();
  expect(inputAfter?.x).toBeCloseTo(inputBefore?.x ?? 0, 0);
  expect(inputAfter?.width).toBeCloseTo(inputBefore?.width ?? 0, 0);

  // the completion chips hang over the body instead of pushing it down
  await input.fill("status:");
  await expect(page.locator(".search-completion").first()).toBeVisible();
  const bodyWithChips = await body.boundingBox();
  expect(bodyWithChips?.y).toBeCloseTo(bodyBefore?.y ?? 0, 0);
});

// SUB-945 motion & feedback: an anchored popover holds a viewport rect taken
// when it opened. Scrolling the rows out from under it left it hanging over
// unrelated data, so the pane dismisses on scroll -- commit-or-close, the same
// contract a click somewhere else already gets.
test("cell editors and header menus close when the rows scroll (SUB-945)", async ({ page }) => {
  // short enough that the rows overflow -- the pane only dismisses on a scroll
  // that actually moved the scroller under the menu
  await page.setViewportSize({ width: 1100, height: 420 });
  await page.goto("/");
  await openDb(page, "Inventory");

  const body = page.locator(".db-body");
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const scroll = () =>
    body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });

  // the header's column menu is anchored to a header cell: it just closes
  const th = page.locator(".db-table thead th").nth(1);
  await th.hover();
  await th.locator(".db-th-caret").click();
  await expect(page.locator(".colmenu")).toHaveCount(1);
  await scroll();
  await expect(page.locator(".colmenu")).toHaveCount(0);

  await body.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });

  // a free-text cell with typed text commits on the way out -- the same thing
  // clicking elsewhere does, so a scroll can never eat an edit
  const acquired = await page
    .locator(".db-table thead th")
    .evaluateAll((ths) =>
      ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith("acquired"))
    );
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  const cell = row.locator("td").nth(acquired);
  await cell.click();
  await page.locator(".selmenu .selmenu-input").fill("1997");
  // A different pane/surface may announce that its own anchor moved. This
  // editor must ignore that event rather than committing globally.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("substrate:anchor-stale", { detail: { scope: "another-pane" } })
    )
  );
  await expect(page.locator(".selmenu")).toHaveCount(1);
  await scroll();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell).toHaveText("1997");
  await expect(cell.locator(".db-cell-flash")).toHaveCount(1);
});

test("bulk bar keeps its closing frame before the timer unmounts it (SUB-945)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const title = page.locator(".db-table tbody tr", { hasText: "Annelies" }).locator(".db-title");
  await title.click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toBeVisible();

  await page.locator(".bulkbar-x").click();
  await expect(page.locator(".bulkbar.closing")).toBeVisible({ timeout: 80 });
  await expect(page.locator(".bulkbar")).toHaveCount(0);
});
