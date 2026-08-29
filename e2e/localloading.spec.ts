import { expect, test, type Page } from "./fixtures";

// Two panes that read purely local data still rendered a loading
// word — the cookbook a "Loading recipes…" line that mounted and unmounted
// again before the cards arrived, the history panel a bare "Loading…" that
// stuck forever under the error strip when the read failed. Same shape
// An earlier fix one pane over set the rule: the loading frame is the resolved state's own
// DOM, and an errored read renders no loading state at all.
//
// The reads are held open with `__mockSetLatency` so the loading frame is
// observable at all — on a real vault the cookbook index is one bundled file
// and the snapshot list is a local revwalk, which is exactly why neither
// should announce itself.

async function openHistory(page: Page) {
  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".hist")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
});

test("the cookbook never announces a load, even on a slow read", async ({ page }) => {
  await page.evaluate(() => window.__mockSetLatency?.("cookbook_index", 500));

  await page.locator(".side-tools").getByRole("button", { name: "Cookbook" }).click();

  // the pane's own copy is up while the index is still in flight — and that
  // copy is all there is: nothing mounts now that would unmount on arrival
  await expect(page.locator(".dash-title")).toHaveText("Cookbook");
  await expect(page.locator(".cb-about")).toBeVisible();
  await expect(page.locator(".cb-recipe")).toHaveCount(0);
  await expect(page.locator(".dash-inner")).not.toContainText("Loading");

  // and the cards land into that same pane
  await expect(page.locator(".cb-recipe")).toHaveCount(2);
  await expect(page.locator(".dash-inner")).not.toContainText("Loading");
});

test("the history list's loading frame is the list's own empty state", async ({ page }) => {
  await page.evaluate(() => window.__mockSetLatency?.("history_list", 500));

  await openHistory(page);

  // same row the resolved empty state renders in, so the snapshots landing
  // only swaps text — and no ellipsis word for a local read
  const empty = page.locator(".hist-list .hist-empty");
  await expect(empty).toHaveText("Reading snapshots");
  await expect(page.locator(".hist-list")).not.toContainText("Loading");

  await expect(page.getByRole("listbox", { name: "Snapshots" }).getByRole("option")).toHaveCount(3);
  await expect(page.locator(".hist-list .hist-empty")).toHaveCount(0);
});

test("the history loading strip stays minimal — no glyph, not the empty shell", async ({
  page,
}) => {
  // This panel's empty states render through the shared EmptyState shell,
  // whose glyph is a required prop. This strip is deliberately NOT one of
  // them: it is a transient local-git-read flash, and is kept bare on
  // purpose. Without this the shell's `.empty` wrapper and its icon can come
  // back here and every other assertion still passes — `toHaveText` reads the
  // same either way, because an svg contributes no text.
  await page.evaluate(() => window.__mockSetLatency?.("history_list", 500));

  await openHistory(page);

  const strip = page.locator(".hist-list .hist-empty");
  await expect(strip).toHaveText("Reading snapshots");
  await expect(strip).not.toHaveClass(/(^|\s)empty(\s|$)/);
  await expect(strip.locator("svg")).toHaveCount(0);
});

test("a failed snapshot read shows the error, not a loading state that sticks", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__mockFail = new Set(["history_list"]);
  });

  await openHistory(page);

  await expect(page.locator(".hist-error")).toContainText("mock failure: history_list");
  // the read is over and it failed: nothing is loading any more
  await expect(page.locator(".hist-list .hist-empty")).toHaveCount(0);
  await expect(page.locator(".hist-list")).not.toContainText("Reading snapshots");
});

test("a snapshot list that loads retires the last error", async ({ page }) => {
  // the diff of the auto-selected newest snapshot fails once, so the panel
  // opens with a list and an error strip over it
  await page.evaluate(() => window.__mockFailOnce?.("history_diff"));

  await openHistory(page);
  await expect(page.locator(".hist-error")).toContainText("mock failure: history_diff");

  // restoring reloads the list — a successful read must clear the strip
  const options = page.getByRole("listbox", { name: "Snapshots" }).getByRole("option");
  await options.nth(1).click();
  await page.getByRole("button", { name: "Restore this version" }).click();

  await expect(page.locator(".hist-error")).toHaveCount(0);
  await expect(options.first()).toContainText("restored");
});
