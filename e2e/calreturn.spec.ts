import { expect, test } from "@playwright/test";

// SUB-521: opening a calendar entry hands the view to the note, so the pane
// unmounts. Everything about "where I was reading" used to die with it —
// coming back (⌫, or the sidebar) dumped you in the current month even if you
// had been three weeks out in week layout. The layout is a preference and the
// cursor is session position; neither may be lost across an open.

/** the calendar's week layout, entered the way the toolbar does */
async function openWeek(page: import("@playwright/test").Page) {
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  const week = page.getByRole("button", { name: "Week", exact: true });
  await week.focus();
  await week.press("Enter");
  await expect(page.locator(".cal-grid.week")).toBeVisible();
}

test("going back from an opened entry returns to the week you left", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openWeek(page);
  const title = await page.locator(".list-title").first().innerText();

  // a digit opens the focused day's Nth entry — the same door Enter and a
  // click use, and the one the bug was reported through. Aim at a day that
  // actually carries one: which weekday that is depends on the fixture's dates.
  const day = page.locator(".cal-wk-col").filter({ has: page.locator(".cal-entry") });
  await day.first().focus();
  await page.keyboard.press("1");
  await expect(page.locator(".note-title")).not.toHaveValue("");

  await page.keyboard.press("Backspace");
  await expect(page.locator(".cal-grid.week")).toBeVisible();
  await expect(page.locator(".list-title").first()).toHaveText(title);
});

test("a paged-to week survives the round trip", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await openWeek(page);
  await page.locator(".cal-wk-col").first().focus();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.press("Meta+ArrowRight");
  const paged = await page.locator(".list-title").first().innerText();

  // leave through the app, not through an entry: same unmount, no note involved
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cal")).toHaveCount(0);
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.week")).toBeVisible();
  await expect(page.locator(".list-title").first()).toHaveText(paged);
});

test("month stays month — the layout is remembered, not forced", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cal")).toHaveCount(0);
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
});
