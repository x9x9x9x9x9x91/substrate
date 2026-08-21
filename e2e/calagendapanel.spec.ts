import { expect, test, type Page } from "@playwright/test";

// The Upcoming panel's three moving parts, in the gate suite rather than in a
// probe: the header latch folds it away and brings it back, the Settings
// switch docks it as a rail, and a dragged size survives a reload. Plus the
// two shapes those parts must not break — the default strip still renders as
// a cap on the panel's height (a sparse agenda shrinks, a full one is not
// clipped by the drag grip), and a rail never takes the day columns below the
// floor that keeps them readable.

/** the floor `.cal-grid-scroll > *` claims: 46px hour gutter + 7 × 110px */
const GRID_FLOOR = 816;

async function openCalendar(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
}

async function openSettings(page: Page) {
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();
}

const panelBox = (page: Page) =>
  page.locator(".cal-agenda").evaluate((el) => ({
    height: Math.round(el.getBoundingClientRect().height),
    width: Math.round(el.getBoundingClientRect().width),
    // the drag grip overlays the panel's leading edge; if it stood in the
    // column flow it would push the heading (and a row of the list) down
    headOffset: (el.querySelector(".cal-agenda-head") as HTMLElement).offsetTop,
  }));

test("the default strip caps its height rather than reserving it", async ({ page }) => {
  await openCalendar(page);
  const before = await panelBox(page);
  expect(before.height).toBe(168);
  expect(before.headOffset).toBe(0);

  // the panel is sized by its content up to that cap: with the list out of the
  // way it gives the room back to the grid instead of holding 168px open
  const sparse = await page.locator(".cal-agenda").evaluate((el) => {
    const body = el.querySelector(".cal-agenda-body") as HTMLElement;
    body.style.display = "none";
    const height = Math.round(el.getBoundingClientRect().height);
    body.style.display = "";
    return height;
  });
  expect(sparse).toBeLessThan(168);
});

test("the header latch folds Upcoming away, brings it back, and is remembered", async ({
  page,
}) => {
  await openCalendar(page);
  const latch = page.getByRole("button", { name: "Upcoming", exact: true });
  await expect(page.locator(".cal-agenda")).toBeVisible();
  await expect(latch).toHaveAttribute("aria-pressed", "true");
  await expect(latch).toHaveAttribute("title", "Hide Upcoming");

  await latch.click();
  await expect(page.locator(".cal-agenda")).toHaveCount(0);
  await expect(latch).toHaveAttribute("aria-pressed", "false");
  await expect(latch).toHaveAttribute("title", "Show Upcoming");

  // folded is a preference, so it is still folded on the next visit
  await page.reload();
  await openCalendar(page);
  await expect(page.locator(".cal-agenda")).toHaveCount(0);

  await page.getByRole("button", { name: "Upcoming", exact: true }).click();
  await expect(page.locator(".cal-agenda")).toBeVisible();
  expect((await panelBox(page)).height).toBe(168);
});

test("a dragged Upcoming height survives a reload", async ({ page }) => {
  await openCalendar(page);
  const grip = page.locator(".cal-agenda-grip");
  const g = await grip.boundingBox();
  if (!g) throw new Error("the panel's drag edge has no box");
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y - 120, { steps: 10 });
  await page.mouse.up();

  const dragged = (await panelBox(page)).height;
  expect(dragged).toBeGreaterThan(240);
  expect(await page.evaluate(() => localStorage.getItem("substrate.calAgenda"))).toContain(
    `"height":${dragged}`
  );

  await page.reload();
  await openCalendar(page);
  expect((await panelBox(page)).height).toBe(dragged);
});

// The rail needs a pane wider than the grid's floor plus the rail's minimum,
// and this window is only just wide enough for it — which is where a rail that
// clamped to 520px regardless of the pane would push the day columns into
// horizontal scrolling.
test.describe("Upcoming docked as a rail", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the Settings switch docks it beside the grid and leaves the day columns readable", async ({
    page,
  }) => {
    await openCalendar(page);
    await expect(page.locator(".cal-body.rail")).toHaveCount(0);

    await openSettings(page);
    const railSwitch = page.locator("#set-cal-agenda-rail");
    await expect(railSwitch).toHaveAttribute("aria-checked", "false");
    await railSwitch.click();
    await expect(railSwitch).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-sheet")).toHaveCount(0);

    await expect(page.locator(".cal-body.rail")).toHaveCount(1);
    await expect(page.locator(".cal-agenda.rail")).toBeVisible();
    const rail = await panelBox(page);
    expect(rail.width).toBeGreaterThanOrEqual(220);
    expect(rail.height).toBeGreaterThan(400);

    // drag the rail as wide as it will go: the grid keeps its floor, so the
    // week and month columns never start scrolling sideways
    const g = await page.locator(".cal-agenda-grip").boundingBox();
    if (!g) throw new Error("the rail's drag edge has no box");
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x - 500, g.y + g.height / 2, { steps: 12 });
    await page.mouse.up();

    const grid = await page.locator(".cal-grid-scroll").evaluate((el) => ({
      clientWidth: Math.round(el.clientWidth),
      scrollWidth: Math.round(el.scrollWidth),
    }));
    expect(grid.clientWidth).toBeGreaterThanOrEqual(GRID_FLOOR);
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);

    // and the switch puts it back under the grid
    await openSettings(page);
    await page.locator("#set-cal-agenda-rail").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cal-body.rail")).toHaveCount(0);
    await expect(page.locator(".cal-agenda")).toBeVisible();
  });
});
