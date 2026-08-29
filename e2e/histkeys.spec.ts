import { expect, test, type Page } from "./fixtures";
import { applyFakeToday, todayBase } from "./clock";

// History snapshots are a real listbox — options carry names,
// selection, and roving focus; arrows move both focus and the loaded diff.

async function openHistory(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".hist")).toBeVisible();
}

test("snapshots form a named listbox with selection and metadata exposed", async ({ page }) => {
  await openHistory(page);

  const listbox = page.getByRole("listbox", { name: "Snapshots" });
  const options = listbox.getByRole("option");
  await expect(options).toHaveCount(3);

  // newest snapshot opens selected, named with its timestamp + latest marker
  const first = options.first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).toContainText("latest");
  await expect(first).toHaveAttribute("tabindex", "0");
  await expect(options.nth(1)).toHaveAttribute("tabindex", "-1");
});

test("arrow keys move focus, selection, and the loaded diff together", async ({ page }) => {
  await openHistory(page);

  const listbox = page.getByRole("listbox", { name: "Snapshots" });
  const options = listbox.getByRole("option");
  await options.first().focus();
  const diffBefore = await page.locator(".hist-diff-lines").textContent();

  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).toHaveAttribute("aria-selected", "false");
  await expect(options.first()).toHaveAttribute("tabindex", "-1");
  // the diff pane follows the selected snapshot
  await expect
    .poll(async () => page.locator(".hist-diff-lines").textContent())
    .not.toBe(diffBefore);

  // restore enables off-latest and stays a native button
  const restore = page.getByRole("button", { name: "Restore this version" });
  await expect(restore).toBeEnabled();
  await page.keyboard.press("End");
  await expect(options.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(options.first()).toBeFocused();
  await expect(restore).toBeDisabled();
});

test("keyboard restore adds a snapshot and marks it restored", async ({ page }) => {
  await openHistory(page);

  const listbox = page.getByRole("listbox", { name: "Snapshots" });
  const options = listbox.getByRole("option");
  await options.first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(2)).toBeFocused();
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(options).toHaveCount(4);
  await expect(options.first()).toContainText("restored");
  await expect(options.first()).toContainText("latest");
});

test("overlay Escape and pointer selection are unchanged", async ({ page }) => {
  await openHistory(page);

  const options = page.getByRole("listbox", { name: "Snapshots" }).getByRole("option");
  await options.last().click();
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".hist")).toHaveCount(0);
});

// The trim date rides the in-house DateMenu (no stock date input) —
// the future-date guard moved into the commit handler and refuses inline
test("trim date picks through DateMenu; a future date is refused inline", async ({ page }) => {
  await openHistory(page);
  await page.locator(".hist-danger-link", { hasText: "Trim vault history…" }).click();

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const now = todayBase();
  const todayHuman = `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

  const dateBtn = page.locator(".hist-purge-date");
  const menu = page.locator(".datemenu");

  // open, pick (grid), commit — today lands on the button, no error.
  // The menu opens on the stored value's month (~30 days back); today's
  // cell only appears in that grid while the two months' 42-cell windows
  // overlap, so step forward to today's month before picking — the pick
  // must not depend on where in the month the run happens to fall.
  const monthsLong = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const todayMonthLabel = `${monthsLong[now.getMonth()]} ${now.getFullYear()}`;
  await dateBtn.click();
  await expect(menu).toBeVisible();
  for (let hops = 0; hops < 2; hops++) {
    const shown = await menu.locator(".datemenu-month").textContent();
    if (shown === todayMonthLabel) break;
    await menu.getByTitle("Next month").click();
  }
  await expect(menu.locator(".datemenu-month")).toHaveText(todayMonthLabel);
  await menu.locator(".datemenu-day.today").click();
  await expect(menu).toHaveCount(0);
  await expect(dateBtn).toHaveText(todayHuman);
  await expect(page.locator(".hist-error")).toHaveCount(0);

  // a typed future date commits through the same menu but is refused inline
  await dateBtn.click();
  await menu.locator(".selmenu-input").fill("2999-01-01");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".hist-error")).toContainText("future");
  // …and the kept value is unchanged
  await expect(dateBtn).toHaveText(todayHuman);

  // a picked range is refused the same way — the threshold is one day
  // (toggling Range arms the current value, so one more click closes a span)
  await dateBtn.click();
  await menu.locator(".selmenu-btn", { hasText: "Range" }).click();
  await menu.locator(".datemenu-day:not(.out)").first().click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".hist-error")).toContainText("single day");
  await expect(dateBtn).toHaveText(todayHuman);

  // Esc on the open menu closes just the menu, not the panel
  await dateBtn.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".hist")).toBeVisible();
});

test("phone history keeps its stacked list and diff geometry", async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await applyFakeToday(page);
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-item", { hasText: /^Scratch/ }).click();
  await page.locator('.list .row[data-path="Welcome.md"]').click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.getByRole("button", { name: "History", exact: true }).click();

  const listbox = page.getByRole("listbox", { name: "Snapshots" });
  await expect(listbox.getByRole("option")).toHaveCount(3);
  const geometry = await listbox.evaluate((el) => {
    const list = el.getBoundingClientRect();
    const diff = el.parentElement?.querySelector(".hist-diff")?.getBoundingClientRect();
    if (!diff) throw new Error("diff pane missing");
    return {
      listWidth: list.width,
      stacked: diff.top >= list.bottom - 1,
      insideViewport: list.left >= 0 && list.right <= 390,
    };
  });
  expect(geometry.stacked).toBe(true);
  expect(geometry.insideViewport).toBe(true);
  await page.close();
});
