import { expect, test, type Page } from "@playwright/test";

// The feed refresh button over the mock
// curator: one click runs the configured `feed-curator` command (mock:
// completes after 1.5s, prepends a curated row to the News Items sheet,
// bumps News.md's `curated:` stamp, emits vault:changed). One run at a
// time; the busy button cancels; a dispatch failure surfaces as the error
// banner. The gate and trust flows around the button live in
// feedgate.spec.ts.

const p = (n: number) => String(n).padStart(2, "0");
/** local "YYYY-MM-DD HH:MM" — the stamp shape a curator writes */
const stampOf = (d: Date) =>
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

/** open the News pane and plug in a curator through the setup card — the
    save is also this machine's approval, so clicks dispatch straight away */
async function openFeed(page: Page) {
  await page.goto("/");
  // the tests assert the stamp bumps on a fresh run: seed it one minute old
  // (fresh — no staleness dot) so the bumped minute always reads different
  const seeded = stampOf(new Date(Date.now() - 60_000));
  await page.evaluate((s) => window.__mockEditProp?.("Dashboards/News.md", "curated", s), seeded);
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  await page.locator(".feed-setup-btn").click();
  await page.locator(".dbform-input").fill("~/scripts/curate-news.sh");
  await page.locator(".dbform").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".dbform")).toHaveCount(0);
}

test("feed refresh: the run lands a curated row and a fresh curated stamp", async ({ page }) => {
  await openFeed(page);
  await expect(page.locator(".dash-state")).toContainText("5 items");
  const stampBefore = (await page.locator(".feed-curated").textContent()) ?? "";
  const btn = page.locator(".feed-refresh");
  await expect(btn).toHaveText("↻ refresh");
  await btn.click();
  // busy while the curator works
  await expect(btn.locator(".sync-spinner")).toBeVisible();
  // the mock curator finishes and its fs writes arrive via vault:changed
  await expect(page.locator(".dash-state")).toContainText("6 items");
  await expect(page.locator(".feed-title").first()).toContainText("Freshly curated");
  await expect(page.locator(".feed-curated")).not.toHaveText(stampBefore);
  await expect(btn).toHaveText("↻ refresh");
  await expect(page.locator(".sync-action-err")).toHaveCount(0);
});

test("feed refresh: clicking the busy button cancels the run, nothing lands", async ({ page }) => {
  await openFeed(page);
  const btn = page.locator(".feed-refresh");
  await btn.click();
  await expect(btn.locator(".sync-spinner")).toBeVisible();
  await btn.click(); // cancel
  await expect(btn).toHaveText("↻ refresh");
  // the cancelled run reports "cancelled" and the stream stays as it was
  await expect(page.locator(".sync-action-err")).toContainText("cancelled");
  await expect(page.locator(".dash-state")).toContainText("5 items");
  // a fresh click dispatches again — the slot was freed
  await btn.click();
  await expect(btn.locator(".sync-spinner")).toBeVisible();
  await expect(page.locator(".dash-state")).toContainText("6 items");
});

test("feed refresh: a dispatch failure surfaces as the error banner", async ({ page }) => {
  await openFeed(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["curator_refresh"]);
  });
  await page.locator(".feed-refresh").click();
  await expect(page.locator(".sync-action-err")).toContainText("curator_refresh");
  // no spinner — nothing dispatched
  await expect(page.locator(".sync-spinner")).toHaveCount(0);
});

test("feed refresh: the ⚙ door reopens the card, and removing the command disarms", async ({
  page,
}) => {
  await openFeed(page);
  await page.locator(".feed-setup-btn[title='Curator settings']").click();
  const dialog = page.locator(".dbform");
  await expect(dialog).toContainText("Feed curator");
  // pre-filled with the configured command
  await expect(dialog.locator(".dbform-input")).toHaveValue("~/scripts/curate-news.sh");
  await dialog.locator(".dbform-input").fill("");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".feed-refresh")).toHaveCount(0);
  await expect(page.locator(".feed-setup-btn")).toHaveText("plug in a curator");
});
