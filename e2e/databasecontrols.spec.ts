import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

async function bootDb(page: Page, name: string) {
  await page.goto("/");
  await openDb(page, name);
}

async function stubWindowOpen(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[]; open: (url?: string) => null };
    w.__opened = [];
    w.open = (url?: string) => {
      w.__opened.push(String(url));
      return null;
    };
  });
}

function openedUrls(page: Page) {
  return page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
}

test("list, gallery, and board cards expose one named roving control (SUB-359)", async ({
  page,
}) => {
  await bootDb(page, "Release");

  await page.getByRole("button", { name: "List", exact: true }).click();
  const list = page.locator(".db-list");
  const listCards = list.locator('[role="button"][data-fr]');
  await expect(listCards).toHaveCount(5);
  await expect(list.locator('[role="button"][tabindex="0"]')).toHaveCount(1);
  const firstList = list.locator('[role="button"][data-fr="0"]');
  await firstList.focus();
  await page.keyboard.press("ArrowDown");
  const secondList = list.locator('[role="button"][data-fr="1"]');
  await expect(secondList).toBeFocused();
  const secondListTitle = await secondList.getAttribute("aria-label");
  await page.keyboard.press("Space");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
    secondListTitle ?? ""
  );

  await openDb(page, "Release");
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  const gallery = page.locator(".db-gallery");
  await expect(gallery.getByRole("button", { name: "Slow Bloom EP", exact: true })).toBeVisible();
  await expect(gallery.locator('[role="button"][tabindex="0"]')).toHaveCount(1);
  const firstGallery = gallery.locator('[role="button"][data-fr="0"]');
  await firstGallery.focus();
  await page.keyboard.press("ArrowRight");
  const secondGallery = gallery.locator('[role="button"][data-fr="1"]');
  await expect(secondGallery).toBeFocused();
  const secondGalleryTitle = await secondGallery.getAttribute("aria-label");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
    secondGalleryTitle ?? ""
  );

  await openDb(page, "Release");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const board = page.locator(".db-board");
  await expect(board.getByRole("button", { name: "Slow Bloom EP", exact: true })).toBeVisible();
  await expect(board.locator('[role="button"][data-fr][tabindex="0"]')).toHaveCount(1);
  const firstBoard = board.locator('[role="button"][data-fc="0"][data-fr="0"]');
  await firstBoard.focus();
  await page.keyboard.press("ArrowDown");
  const secondBoard = board.locator('[role="button"][data-fc="0"][data-fr="1"]');
  await expect(secondBoard).toBeFocused();
  const secondBoardTitle = await secondBoard.getAttribute("aria-label");
  await page.keyboard.press("Space");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
    secondBoardTitle ?? ""
  );

  await openDb(page, "Release");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const slowBloom = page
    .locator(".db-board")
    .getByRole("button", { name: "Slow Bloom EP", exact: true });
  await expect(slowBloom).toHaveAttribute("draggable", "true");
  await slowBloom.focus();
  const live = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "live" }),
  });
  await slowBloom.dragTo(live);
  const movedSlowBloom = live.getByRole("button", { name: "Slow Bloom EP", exact: true });
  await expect(movedSlowBloom).toBeFocused();
  await expect(movedSlowBloom).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(".ctx-item").first()).toBeVisible();
});

test("table focus, sort, edit, checkbox, and external link actions stay distinct (SUB-359)", async ({
  page,
}) => {
  await bootDb(page, "Release");
  const table = page.locator(".db-table");
  await expect(table.locator("tbody .db-cell[tabindex='0']")).toHaveCount(1);
  const firstTitle = table.locator('[data-fc="0"][data-fr="0"]');
  await firstTitle.focus();
  await page.keyboard.press("ArrowRight");
  const firstStatus = table.locator('[data-fc="1"][data-fr="0"]');
  await expect(firstStatus).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".selmenu")).toBeVisible();
  await page.keyboard.press("Escape");

  await firstTitle.focus();
  const firstTitleText = (await firstTitle.textContent())?.trim() ?? "";
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(firstTitleText);

  await openDb(page, "Release");
  const staleCell = page.locator('.db-table [data-fc="0"][data-fr="0"]');
  await staleCell.focus();
  const nameSort = page.getByRole("button", { name: "Sort by Name", exact: true });
  await nameSort.focus();
  await nameSort.press("Enter");
  await expect(nameSort.locator(".db-sort")).toHaveText("↑");
  await expect(page.locator(".db-table")).toBeVisible();
  const fernTitle = page
    .locator("tr", { has: page.locator(".db-title-txt", { hasText: "Fern Palace" }) })
    .locator(".db-title");
  await fernTitle.focus();
  const statusSort = page.getByRole("button", { name: "Sort by Status", exact: true });
  await statusSort.focus();
  await statusSort.press("Space");
  await expect(statusSort.locator(".db-sort")).toHaveText("↑");
  await expect(statusSort).toBeFocused();
  const movedFernTitle = page
    .locator("tr", { has: page.locator(".db-title-txt", { hasText: "Fern Palace" }) })
    .locator(".db-title");
  await expect(movedFernTitle).toHaveAttribute("tabindex", "0");

  await openDb(page, "Inventory");
  const uncheckedRow = page.locator("tr", {
    has: page.locator(".db-title-txt", { hasText: "Nordvik One" }),
  });
  const checkboxCell = uncheckedRow.locator("td", { has: page.locator(".prop-check") });
  await checkboxCell.focus();
  await page.keyboard.press("Enter");
  await expect(checkboxCell.locator(".prop-check")).toHaveClass(/on/);

  const link = page.getByRole("link", { name: "aeon.audio/driftbox", exact: true });
  expect(
    await link.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "A", tabIndex: 0 });
  await stubWindowOpen(page);
  await link.focus();
  await link.press("Enter");
  await expect.poll(() => openedUrls(page)).toEqual(["https://www.aeon.audio/driftbox"]);
  await expect(page.locator(".selmenu")).toHaveCount(0);

  const inventoryTitle = page.locator('.db-table [data-fc="0"][data-fr="0"]');
  await inventoryTitle.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".db-cell.focused")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
});

test("windowed tables move real focus beyond the initial painted slice (SUB-359)", async ({ page }) => {
  // 90 real ArrowDown presses, each a CDP round trip: ~4s of irreducible
  // driver cost on an idle machine and ~15s when the suite's other 3 workers
  // are competing for CPU — measured, not guessed. The default 20s budget
  // left no headroom, so this timed out ~20% of the time under load while
  // focus was in fact correct on every row (the failures always reported
  // document.activeElement exactly on the row being awaited). Declare the
  // real cost rather than thin the coverage: the per-row assertion below is
  // the point of the test, since it proves focus crosses the window seam.
  // A CI container runs the same loop ~6× slower than the machine those
  // numbers were measured on (whole-suite wall clock, same commit), which put
  // it past even test.slow()'s 60s while every row still focused correctly —
  // so the budget is stated outright instead of multiplied. Measured on the
  // shared runner: 150s still clipped a correct run at 2.5m (pipeline
  // 2716983810), so the ceiling is 2× that observation.
  test.setTimeout(300_000);
  await page.goto("/?perfdb=140");
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
  const body = page.locator(".db-body");
  const first = page.locator('.db-table [data-fc="0"][data-fr="0"]');
  await first.focus();
  const nameSort = page.getByRole("button", { name: "Sort by Name", exact: true });
  await nameSort.focus();
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(nameSort).toBeFocused();
  await body.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await first.focus();
  for (let r = 1; r <= 90; r++) {
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(`.db-table [data-fc="0"][data-fr="${r}"]`)).toBeFocused();
  }
  const target = page.locator('.db-table [data-fc="0"][data-fr="90"]');
  const title = (await target.textContent())?.trim() ?? "";
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("database controls retain phone navigation and horizontal geometry (SUB-359)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".mobile-menu").click();
    await page.locator(".side-item", { hasText: "All databases" }).click();
    await page.locator(".dbmgr-row", { hasText: "Release" }).click();

    const firstTitle = page.locator('.db-table [data-fc="0"][data-fr="0"]');
    await firstTitle.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('.db-table [data-fc="0"][data-fr="1"]')).toBeFocused();
    const tableGeometry = await page.locator(".db-body").evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(tableGeometry.scrollWidth).toBeGreaterThan(tableGeometry.clientWidth);

    await page.getByRole("button", { name: "Board", exact: true }).click();
    const boardGeometry = await page.locator(".db-board").evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(boardGeometry.scrollWidth).toBeGreaterThan(boardGeometry.clientWidth);
    const card = page
      .locator(".db-board")
      .getByRole("button", { name: "Slow Bloom EP", exact: true });
    await card.focus();
    await card.press("Space");
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Slow Bloom EP");
  });
});
