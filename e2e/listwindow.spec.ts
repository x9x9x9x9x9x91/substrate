import { expect, test, type Page } from "@playwright/test";

// ListPane paints only the scroll viewport ± overscan once a list runs
// past WIN_MIN (60) rows, with spacer divs standing in for the rest. The pane's
// semantics — count, keyboard selection, drag, context menu — all operate on the
// note array, not the DOM, so they must survive unchanged.

// comfortably past WIN_MIN (60) with room for the window to move, but small
// enough that six seeded pages don't slow the whole suite's shared machine
// down into timeout flakes elsewhere
const SEEDED = 150;

/** Seed a windowing-sized folder, then open it. The seed runs before the app
    boots so the very first vault_list already carries the long list. */
async function openSeeded(page: Page, count = SEEDED) {
  await page.addInitScript(
    ([n]) => {
      // the mock hook only exists once tauri.ts has run, so wait for it
      const install = () => {
        if (!window.__mockSeedNotes) return void setTimeout(install, 0);
        window.__mockSeedNotes("Inbox", n as number);
      };
      install();
    },
    [count]
  );
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");
  // the header counts the whole list even though the DOM holds a slice — the
  // fixture's own Inbox rows sit on top of the seeds, so assert the floor
  await expect
    .poll(async () => Number(await page.locator(".list-count").innerText()))
    .toBeGreaterThanOrEqual(count);
}

test("a long list paints a slice, not every row (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  const rows = page.locator(".list .row");
  const painted = await rows.count();
  expect(painted).toBeGreaterThan(10);
  expect(painted).toBeLessThan(SEEDED);

  // the spacers make the scroll height match a full render: the scroller is
  // taller than its viewport by roughly the unpainted rows' worth of height
  const body = page.locator(".list-body");
  const { scrollH, clientH } = await body.evaluate((el) => ({
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));
  expect(scrollH).toBeGreaterThan(clientH * 5);
});

test("a short list renders whole — no spacers below WIN_MIN (SUB-461)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-win-spacer")).toHaveCount(0);
});

test("scrolling swaps the painted slice; rows keep their identity (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  const body = page.locator(".list-body");

  // the first seeded row is painted at rest, and gone after a long scroll
  const first = page.locator('.list .row[data-path="Inbox/Seeded 0001.md"]');
  await expect(first).toBeVisible();

  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await expect(first).toHaveCount(0);
  // a mid-list row is painted, titled, and clickable — the slice moved, the
  // rows are not recycled placeholders
  const path = await page.locator(".list .row").nth(5).getAttribute("data-path");
  expect(path).toMatch(/^Inbox\/Seeded \d{4}\.md$/);
  // pin the row by path, not by index: selecting it re-syncs the window, and
  // nth(5) would then name whichever row slid into that slot
  const mid = page.locator(`.list .row[data-path="${path}"]`);
  await mid.click();
  await expect(mid).toHaveClass(/selected/);

  // scrolling back re-paints the first row
  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(first).toBeVisible();
});

test("arrow keys walk into unpainted rows, scrolling the window (SUB-461)", async ({ page }) => {
  // 120 real key presses, each a CDP round trip: ~3s here, but a CI container
  // runs the suite ~6× slower and blew the 20s default while the walk itself
  // was fine. Same call as the table walk — pay for the round trips,
  // keep every step.
  test.setTimeout(120_000);
  await openSeeded(page);
  const rows = page.locator(".list .row");
  await rows.first().click();
  const startPath = await rows.first().getAttribute("data-path");

  // far past WIN_INITIAL (64). A step-by-step walk never actually outruns the
  // window — each press moves one row and the reveal re-syncs before the next —
  // so this covers the in-window path: the slice must follow, and focus must
  // ride along from row to row.
  for (let i = 0; i < 120; i++) await page.keyboard.press("ArrowDown");
  const selected = page.locator(".list .row.selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeVisible();
  expect(await selected.getAttribute("data-path")).not.toBe(startPath);
  // row 0 is well behind the window by now — proof the slice actually moved
  await expect(rows.first()).not.toHaveAttribute("data-path", startPath ?? "");
  await expect(selected).toBeFocused();

  // and it is the row the editor opened, so selection and window agree
  const path = (await selected.getAttribute("data-path")) ?? "";
  const stem = path.replace(/^Inbox\//, "").replace(/\.md$/, "");
  await expect(page.locator(".note-title")).toHaveValue(stem);
});

test("keyboard focus survives the focused row being scrolled out (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  // clicking a row puts DOM focus on it; scrolling far enough unmounts that row,
  // which silently drops focus to <body>. Before windowing rows never unmounted,
  // so the next arrow key has to put the ring back or the keyboard is orphaned.
  await page.locator(".list .row").first().click();
  await expect(page.locator(".list .row.selected")).toBeFocused();
  await page.locator(".list-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });
  await expect.poll(() => page.evaluate(() => document.activeElement?.nodeName)).toBe("BODY");

  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".list .row.selected")).toBeFocused();
});

test("the palette jumps straight to an unpainted row (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  // a one-row-at-a-time walk never outruns the window; a palette jump does —
  // it selects a row hundreds of positions away in a single render, which is
  // the only way into the out-of-window reveal branch.
  const target = "Seeded 0140";
  await expect(page.locator(`.list .row[data-path="Inbox/${target}.md"]`)).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill(target);
  await expect(page.locator(".palette-item.selected")).toContainText(target);
  await page.keyboard.press("Enter");

  // the window followed the jump: the row is painted, selected, and on screen
  const row = page.locator(`.list .row[data-path="Inbox/${target}.md"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/selected/);
  await expect(row).toBeInViewport();
});

test("a windowed row still drags to a folder (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  const source = page.locator('.list .row[data-path="Inbox/Seeded 0001.md"]');
  await expect(source).toBeVisible();
  await source.dragTo(page.locator(".side-folder", { hasText: "Field notes" }));
  // the move landed: the row left the Inbox list
  await expect(page.locator('.list .row[data-path="Inbox/Seeded 0001.md"]')).toHaveCount(0);
  await page.locator(".side-folder", { hasText: "Field notes" }).click();
  await expect(
    page.locator('.list .row[data-path="Field notes/Seeded 0001.md"]')
  ).toBeVisible();
});

test("switching to a same-length folder paints rows, not blank spacer (SUB-461)", async ({
  page,
}) => {
  // two windowed folders of equal length: the reset effect clears the window
  // and the measure effect's deps (notes.length) don't change either, so the
  // only thing that re-syncs the slice is the reveal effect scrolling onto the
  // newly selected row. Guards the reset path against a stale mid-list window
  // surviving into a scroller parked where the previous folder left it.
  await page.addInitScript(() => {
    const install = () => {
      if (!window.__mockSeedNotes) return void setTimeout(install, 0);
      window.__mockSeedNotes("Inbox", 150);
      window.__mockSeedNotes("Field notes", 150);
    };
    install();
  });
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");

  // park the scroller deep in the first folder
  await page.locator(".list-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });
  await expect.poll(async () => page.locator(".list-body").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1000);

  await page.locator(".side-folder", { hasText: "Field notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("Field notes");
  // the viewport must show rows, not the blank band a stale window leaves
  await expect(page.locator(".list .row").first()).toBeInViewport();
});

test("a view switch that keeps the selection keeps it painted (SUB-461)", async ({ page }) => {
  // folder -> All notes carries the same note in scope, so the reveal effect
  // sees no new selection and does nothing. Anything that resets the scroller
  // on view change therefore strands the selected row outside the window with
  // nothing left to scroll it back.
  await openSeeded(page);
  const target = "Seeded 0140";
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill(target);
  await expect(page.locator(".palette-item.selected")).toContainText(target);
  await page.keyboard.press("Enter");
  const row = page.locator(`.list .row[data-path="Inbox/${target}.md"]`);
  await expect(row).toBeVisible();

  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await expect(page.locator(`.list .row[data-path="Inbox/${target}.md"]`)).toHaveClass(/selected/);
  await expect(page.locator(`.list .row[data-path="Inbox/${target}.md"]`)).toBeInViewport();
});

test("growing the viewport repaints the slice (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  const painted = () => page.locator(".list .row").count();
  const before = await painted();
  // a taller window shows more rows only if something re-windows on resize —
  // no scroll event fires here
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp?.width ?? 1280, height: (vp?.height ?? 720) * 2 });
  await expect.poll(painted).toBeGreaterThan(before);
});

test("rename from the sidebar reaches an unpainted row (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  // pin a row near the top, scroll far past it, then rename via the pin menu —
  // the row is unmounted, so the edit field only appears if the window follows
  const target = page.locator('.list .row[data-path="Inbox/Seeded 0002.md"]');
  await target.click({ button: "right" });
  await page.locator(".ctx-menu").getByText(/^Pin/).click();
  await page.locator(".list-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });
  await expect(page.locator('.list .row[data-path="Inbox/Seeded 0002.md"]')).toHaveCount(0);

  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Seeded 0002", exact: true })
    .click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Rename").click();
  await expect(page.locator(".list .row .inline-edit")).toBeVisible();
});

test("right-click on a windowed row opens its menu (SUB-461)", async ({ page }) => {
  await openSeeded(page);
  const path = await page.locator(".list .row").nth(3).getAttribute("data-path");
  const target = page.locator(`.list .row[data-path="${path}"]`);
  await target.click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  // the menu belongs to the row that was clicked — right-click selects first
  await expect(page.locator(".list .row.selected")).toHaveAttribute("data-path", path ?? "");
});
