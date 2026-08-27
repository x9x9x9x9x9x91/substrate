import { expect, test, type Page } from "./fixtures";

// The non-drag path to assignable keys. Right-click a
// sidebar destination → "Assign key…" → pick a chip. Same plumbing as the
// drag (assignKey/unassignKey), so the assertions mirror keyassign.spec.ts:
// the row wears the chip, the key navigates, and "Remove key" frees it.

const sideRow = (page: Page, label: string) =>
  page.locator(".side-item", { hasText: label }).first();

const ctxItem = (page: Page, label: string) =>
  page.locator(".ctx-item", { hasText: label }).first();

/** Right-click `label`'s row and open its key picker. */
async function openPicker(page: Page, row = sideRow(page, "Calendar")): Promise<void> {
  await row.click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await ctxItem(page, "Assign key…").click();
  await expect(page.locator(".ctx-menu")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
});

test("assign a key from the row menu: the row wears it and the key navigates", async ({ page }) => {
  const calendar = sideRow(page, "Calendar");
  await openPicker(page, calendar);

  // the picker lists the free pool, in pool order — ⌘5 first (a fresh mock
  // vault has no saved views, so nothing is shadowed)
  await expect(page.locator(".ctx-item").first()).toHaveText(/⌘5/);
  await ctxItem(page, "⌘5").click();

  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // the binding works: park somewhere else, then press it
  await sideRow(page, "Notes").click();
  await expect(page.locator(".side-item.active", { hasText: "Notes" })).toBeVisible();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: "Calendar" })).toBeVisible();
});

test("Remove key clears the binding and the key stops navigating", async ({ page }) => {
  const calendar = sideRow(page, "Calendar");
  await openPicker(page, calendar);
  await ctxItem(page, "⌘5").click();
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // the lane now advertises the bound key and offers the removal
  await calendar.click({ button: "right" });
  await expect(ctxItem(page, "Assign key…").locator(".ctx-hint")).toHaveText("⌘5");
  await ctxItem(page, "Remove key").click();
  await expect(calendar.locator(".side-key-chip")).toHaveCount(0);

  await sideRow(page, "Notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: "Notes" })).toBeVisible();
});

test("an unbound row's menu offers no Remove key", async ({ page }) => {
  await sideRow(page, "Calendar").click({ button: "right" });
  await expect(ctxItem(page, "Assign key…")).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Remove key" })).toHaveCount(0);
});

test("the menu path shares the drag path's state: the HUD sees the assignment", async ({
  page,
}) => {
  const calendar = sideRow(page, "Calendar");
  await openPicker(page, calendar);
  await ctxItem(page, "⌘5").click();
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // open the HUD: ⌘5 is gone from its free grid and listed as assigned
  await page.keyboard.press("Meta+/");
  await page.locator(".sheet-assign-btn").click();
  await expect(page.locator(".key-hud")).toBeVisible();
  await expect(page.locator(".key-hud-grid .key-chip", { hasText: "⌘5" })).toHaveCount(0);
  await expect(page.locator(".key-hud-row-label", { hasText: "Calendar" })).toBeVisible();
});

test("a folder row's menu carries the key lane alongside its own actions", async ({ page }) => {
  const projects = page.locator(".side-folder", { hasText: "Projects" }).first();
  await projects.click({ button: "right" });
  // the folder's own actions are still there…
  await expect(ctxItem(page, "New subfolder…")).toBeVisible();
  // …and the key lane joins them
  await ctxItem(page, "Assign key…").click();
  await ctxItem(page, "⌘5").click();
  await expect(projects.locator(".side-key-chip")).toHaveText("⌘5");

  await sideRow(page, "Notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-folder.active", { hasText: "Projects" })).toBeVisible();
});

test("re-assigning from the menu moves the key off the previous row", async ({ page }) => {
  const calendar = sideRow(page, "Calendar");
  await openPicker(page, calendar);
  await ctxItem(page, "⌘5").click();
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // ⌘5 is bound elsewhere, so it is no longer offered on another row
  const notes = sideRow(page, "Scratch");
  await openPicker(page, notes);
  await expect(page.locator(".ctx-item", { hasText: "⌘5" })).toHaveCount(0);
  await ctxItem(page, "⌘6").click();
  await expect(notes.locator(".side-key-chip")).toHaveText("⌘6");
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");
});

// The menu is keyboard-drivable once open (ContextMenu.tsx owns arrows/Enter/
// Esc); this pins that the whole assignment can be completed without a mouse
// after the menu is summoned.
test("the picker completes by keyboard", async ({ page }) => {
  const calendar = sideRow(page, "Calendar");
  await calendar.click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.keyboard.press("ArrowDown"); // "Assign key…" is the only item
  await expect(page.locator(".ctx-item.selected")).toHaveText(/Assign key/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".ctx-item").first()).toHaveText(/⌘5/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");
});
