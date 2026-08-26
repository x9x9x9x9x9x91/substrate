import { expect, test } from "./fixtures";
import { openDb, openFilter } from "./nav";

// The database header's second row is the Notion-style view tab bar: "All"
// plus one tab per saved view of the db, the active tab underlined, a ＋
// that starts the save-view naming flow, and the tools right-aligned on the
// same row. Runs against the deterministic mock backend (fresh page = fresh
// vault per test).

test("view tabs: render, click switches, All returns, ＋ names a view", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  // seed two saved views through the app's own save flow
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  let nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  await page.locator(".db-filter-input").fill("status:mastering ");
  await page.locator(".db-filter-save").click();
  nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Mastering");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "Mastering" })).toHaveCount(1);

  // the strip renders All + both pins, All active on the plain db
  const tabs = page.locator(".db-tab");
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveText("All");
  await expect(tabs.nth(1)).toHaveText("Live releases⌘5");
  await expect(tabs.nth(2)).toHaveText("Mastering⌘6");
  await expect(page.locator(".db-tab.active")).toHaveText("All");

  // Pinned tabs carry their ⌘-digit in pin order; "All" never does
  await expect(tabs.nth(0).locator(".key")).toHaveCount(0);
  await expect(tabs.nth(1).locator(".key")).toHaveText("⌘5");
  await expect(tabs.nth(2).locator(".key")).toHaveText("⌘6");

  // clicking a tab opens its view: query + rows follow, the active mark
  // moves, the db title stays the database's
  await tabs.filter({ hasText: "Live releases" }).click();
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-tab.active")).toHaveText("Live releases⌘5");
  await expect(page.locator(".db-filter-input")).toHaveValue("status:live");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  await tabs.filter({ hasText: "Mastering" }).click();
  await expect(page.locator(".db-tab.active")).toHaveText("Mastering⌘6");
  await expect(page.locator(".db-filter-input")).toHaveValue("status:mastering");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  // the All tab leaves the pin for the plain database
  await tabs.filter({ hasText: "All" }).click();
  await expect(page.locator(".db-tab.active")).toHaveText("All");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  // the ＋ starts the save-view naming flow in the filter row
  await page.locator(".db-tab-add").click();
  nameInput = page.locator(".db-filter .inline-edit");
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeFocused();
  await nameInput.fill("From plus");
  await nameInput.press("Enter");
  await expect(page.locator(".db-tab")).toHaveCount(4);
  await expect(page.locator(".side-view", { hasText: "From plus" })).toHaveCount(1);
});

// A pin on a HOMED database renders nowhere in the sidebar — the
// view tab is its only row, so the tab carries the pin's ⌘-digit. Homing the
// database must not change the digit: the order is the pin order either way.
test("a homed database's pin keeps its ⌘-digit on its view tab", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  // homeless: the pin is a sidebar row AND a tab carrying the first pin digit
  await expect(page.locator(".side-view", { hasText: "Live releases" })).toHaveCount(1);
  await expect(
    page.locator(".db-tab", { hasText: "Live releases" }).locator(".key")
  ).toHaveText("⌘5");

  // home the database — the pin's sidebar row goes with it
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Set home folder…" }).click();
  await page.locator(".ctx-item", { hasText: /^Projects$/ }).click();
  await expect(page.locator(".side-view", { hasText: "Live releases" })).toHaveCount(0);

  // the tab strip keeps the pin and its digit — the shortcut never moved —
  // and ⌘5 really opens it
  await openDb(page, "Release");
  await expect(
    page.locator(".db-tab", { hasText: "Live releases" }).locator(".key")
  ).toHaveText("⌘5");
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".db-tab.active")).toHaveText("Live releases⌘5");
});

test("the filter row is on-demand: hidden when empty, the funnel opens it", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");

  // an empty untouched db renders no filter row — the space is reclaimed
  await expect(page.locator(".db-filter")).toHaveCount(0);
  await expect(page.locator(".db-filter-toggle")).not.toHaveClass(/active/);

  // the funnel toggles it open and lands the caret in the input
  await page.locator(".db-filter-toggle").click();
  const input = page.locator(".db-filter-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(page.locator(".db-filter-toggle")).toHaveClass(/active/);

  // Escape on the empty input closes the row again
  await input.press("Escape");
  await expect(page.locator(".db-filter")).toHaveCount(0);

  // a live query keeps the row on screen — toggling can't hide it
  await page.locator(".db-filter-toggle").click();
  await input.fill("status:live ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
  await page.locator(".db-filter-toggle").click();
  await expect(page.locator(".db-filter")).toHaveCount(1);
});
