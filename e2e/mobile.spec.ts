import { expect, test } from "@playwright/test";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("phone shell is a drawer plus a single-pane navigation stack (SUB-332)", async ({
  page,
}) => {
  await page.goto("/");

  // Cold open stops at the list: no auto-selected note stealing the first
  // screen, and the desktop rail lives off-canvas until explicitly opened.
  await expect(page.locator(".mobile-menu")).toBeVisible();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".list")).toBeVisible();
  await expect(page.locator(".note")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toBeHidden();

  await page.locator(".mobile-menu").click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveAttribute("aria-hidden", "false");

  // Phone navigation advertises phone-capable surfaces, not desktop helpers
  // or hardware-key shortcuts. Counts remain visible; only shortcut badges go.
  await expect(page.locator(".sidebar .side-shortcut").first()).toBeHidden();
  const notesTarget = await page
    .locator(".sidebar .side-item", { hasText: /^Notes/ })
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(notesTarget).toBeGreaterThanOrEqual(44);

  await page.locator(".sidebar .side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".sidebar")).toBeHidden();

  // A row pushes a full-width note. The visible back control and the native-
  // style left-edge swipe both pop to the list.
  await page.locator('.list .row[data-path="Welcome.md"]').click();
  await expect(page.locator(".list")).toHaveCount(0);
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(page.locator(".mobile-back")).toBeVisible();

  // Scrolled prose used to paint through the transparent full-width tools
  // row, colliding with Back, History and the overflow menu.
  await page.locator(".note").evaluate((el) => {
    el.scrollTop = 260;
  });
  const phoneChrome = await page.locator(".note-tools").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      background: getComputedStyle(el).backgroundColor,
    };
  });
  expect(phoneChrome).toMatchObject({ top: 0, right: 390, left: 0 });
  expect(phoneChrome.bottom).toBeGreaterThanOrEqual(54);
  expect(phoneChrome.background).not.toBe("rgba(0, 0, 0, 0)");

  await page.locator(".app").dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 8,
    clientY: 300,
  });
  await page.locator(".app").dispatchEvent("pointerup", {
    pointerType: "touch",
    clientX: 104,
    clientY: 306,
  });
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".note")).toHaveCount(0);

  // Database side notes use the same stack instead of recreating the desktop
  // split: database → note → database.
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item", { hasText: "All databases" }).click();
  await expect(page.locator(".dbmgr-row", { hasText: "Release" })).toBeVisible();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await expect(page.locator(".db-table")).toBeVisible();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .click();
  await expect(page.locator(".main.mobile-detail .note-title")).toHaveValue("Slow Bloom EP");
  await expect(page.locator(".main.mobile-detail > .db")).toBeHidden();
  await page.locator(".mobile-back").click();
  await expect(page.locator(".db-table")).toBeVisible();
});

test("phone history stacks snapshots above a readable full-width diff (SUB-344)", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('.list .row[data-path="Welcome.md"]').click();
  await page.locator('.note-tool[aria-label="History"]').click();

  const panel = page.locator(".hist");
  await expect(panel).toBeVisible();
  await expect(page.locator(".hist-item")).toHaveCount(3);

  const geometry = await panel.evaluate((el) => {
    const rect = (selector: string) => {
      const node = el.querySelector(selector);
      if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
      return node.getBoundingClientRect().toJSON();
    };
    const foot = el.querySelector(".hist-foot");
    if (!(foot instanceof HTMLElement)) throw new Error("missing history footer");
    return {
      panel: el.getBoundingClientRect().toJSON(),
      list: rect(".hist-list"),
      diff: rect(".hist-diff"),
      foot: foot.getBoundingClientRect().toJSON(),
      footOverflow: foot.scrollWidth - foot.clientWidth,
    };
  });

  expect(geometry.list.width).toBeGreaterThan(340);
  expect(geometry.diff.width).toBeGreaterThan(340);
  expect(geometry.diff.top).toBeGreaterThanOrEqual(geometry.list.bottom - 1);
  expect(geometry.foot.top).toBeGreaterThanOrEqual(geometry.diff.bottom - 1);
  expect(geometry.footOverflow).toBeLessThanOrEqual(0);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(844);

  const links = page.locator(".hist-danger-link");
  await expect(links).toHaveCount(3);
  for (const link of await links.all()) {
    expect((await link.boundingBox())?.height).toBeLessThan(24);
  }

  await links.first().click();
  const purge = page.locator(".hist-purge");
  await expect(purge).toBeVisible();
  const purgeGeometry = await purge.evaluate((el) => ({
    overflow: el.scrollWidth - el.clientWidth,
    inputWidth: el.querySelector(".hist-purge-input")?.getBoundingClientRect().width,
  }));
  expect(purgeGeometry.overflow).toBeLessThanOrEqual(0);
  expect(purgeGeometry.inputWidth).toBeGreaterThan(320);
});

test("phone calendar preserves readable seven-day columns in one swipe surface (SUB-342)", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item:not(.side-folder)", { hasText: /^Calendar/ }).click();

  const viewport = page.locator(".cal-grid-scroll");
  await expect(viewport).toBeVisible();
  const monthGeometry = await viewport.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    weekdayWidth: el.querySelector(".cal-weekdays")?.getBoundingClientRect().width,
    gridWidth: el.querySelector(".cal-grid")?.getBoundingClientRect().width,
  }));
  expect(monthGeometry.scrollWidth).toBeGreaterThan(monthGeometry.clientWidth);
  expect(monthGeometry.weekdayWidth).toBe(monthGeometry.gridWidth);

  const monthChipWidth = await page.locator(".cal-grid.month .cal-entry").first().evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  expect(monthChipWidth).toBeGreaterThanOrEqual(90);

  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  const weekCardWidth = await page.locator(".cal-grid.week .cal-entry").first().evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  expect(weekCardWidth).toBeGreaterThanOrEqual(100);

  await viewport.evaluate((el) => el.scrollTo({ left: 240 }));
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test("calendar stays readable immediately above the phone breakpoint (SUB-343)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 701, height: 900 });
  await page.goto("/");
  await page.locator(".sidebar .side-item:not(.side-folder)", { hasText: /^Calendar/ }).click();
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();

  const viewport = page.locator(".cal-grid-scroll");
  const narrowGeometry = await viewport.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    weekdayWidth: el.querySelector(".cal-weekdays")?.getBoundingClientRect().width,
    gridWidth: el.querySelector(".cal-grid")?.getBoundingClientRect().width,
  }));
  expect(narrowGeometry.scrollWidth).toBeGreaterThan(narrowGeometry.clientWidth);
  expect(narrowGeometry.weekdayWidth).toBe(narrowGeometry.gridWidth);

  const cardWidth = await page.locator(".cal-grid.week .cal-entry").first().evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  expect(cardWidth).toBeGreaterThanOrEqual(95);
  await viewport.evaluate((el) => el.scrollTo({ left: 160 }));
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

  // The minimum is inert once the pane has room: ordinary desktop stays a
  // full seven-column grid, not a needlessly scrollable fixed-width canvas.
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopGeometry = await viewport.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(desktopGeometry.clientWidth).toBeGreaterThan(770);
  expect(desktopGeometry.scrollWidth).toBe(desktopGeometry.clientWidth);
});

test("SE-width Search and Calendar headers keep primary controls visible (SUB-346)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");

  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item", { hasText: /^Search/ }).click();
  await page.locator(".search-input").fill("master");
  await expect(page.locator(".search-stats")).toContainText("matches");

  const search = await page.locator(".search-head").evaluate((el) => {
    const input = el.querySelector(".search-input");
    const stats = el.querySelector(".search-stats");
    const sort = el.querySelector(".search-sort");
    if (
      !(input instanceof HTMLElement) ||
      !(stats instanceof HTMLElement) ||
      !(sort instanceof HTMLElement)
    ) {
      throw new Error("missing Search header controls");
    }
    return {
      overflow: el.scrollWidth - el.clientWidth,
      input: input.getBoundingClientRect().toJSON(),
      stats: stats.getBoundingClientRect().toJSON(),
      sort: sort.getBoundingClientRect().toJSON(),
    };
  });
  expect(search.overflow).toBeLessThanOrEqual(0);
  expect(search.input.width).toBeGreaterThan(250);
  expect(search.stats.top).toBeGreaterThanOrEqual(search.input.bottom - 1);
  expect(search.sort.right).toBeLessThanOrEqual(375);

  await page.locator(".mobile-menu").click();
  await page
    .locator(".sidebar .side-item:not(.side-folder)", { hasText: /^Calendar/ })
    .click();
  await expect(page.locator(".cal-grid.month")).toBeVisible();

  const calendar = await page.locator(".cal .list-head").evaluate((el) => {
    const title = el.querySelector(".list-title");
    const tools = el.querySelector(".db-tools");
    const week = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Week",
    );
    const grid = document.querySelector(".cal-grid-scroll");
    if (
      !(title instanceof HTMLElement) ||
      !(tools instanceof HTMLElement) ||
      !(week instanceof HTMLElement) ||
      !(grid instanceof HTMLElement)
    ) {
      throw new Error("missing Calendar header controls");
    }
    return {
      overflow: el.scrollWidth - el.clientWidth,
      title: title.getBoundingClientRect().toJSON(),
      tools: tools.getBoundingClientRect().toJSON(),
      week: week.getBoundingClientRect().toJSON(),
      grid: grid.getBoundingClientRect().toJSON(),
    };
  });
  expect(calendar.overflow).toBeLessThanOrEqual(0);
  expect(calendar.tools.top).toBeGreaterThanOrEqual(calendar.title.bottom - 1);
  expect(calendar.week.width).toBeGreaterThan(40);
  expect(calendar.week.right).toBeLessThanOrEqual(375);
  expect(calendar.grid.top).toBeGreaterThanOrEqual(calendar.tools.bottom);
});
