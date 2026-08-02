import { expect, test } from "@playwright/test";

// SUB-648: the feed refresh button dispatches to ONE machine's checkout of
// the news curator agent, so it is not a universal affordance — it only
// renders where the `curator_available` probe finds the skill. The demo vault
// ships the feed pane; the probe hides the dead dispatch everywhere else.
// This spec pins both halves of that gate; the button's own behavior lives in
// feedrefresh.spec.ts.
//
// The unavailable machine is expressed through the existing __mockFail hook:
// the UI reads a rejecting probe as "no skill here".

test("no skill on this machine → no refresh button, no error banner", async ({ page }) => {
  await page.addInitScript(() => {
    window.__mockFail = new Set(["curator_available"]);
  });
  await page.goto("/");
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  // the pane itself renders in full — only the dispatch is gated
  await expect(page.locator(".dash-state")).toContainText("5 items");
  await expect(page.locator(".feed-title").first()).toBeVisible();
  await expect(page.locator(".feed-refresh")).toHaveCount(0);
  await expect(page.locator(".sync-action-err")).toHaveCount(0);
});

test("a skill machine gets the button, and it dispatches", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  const btn = page.locator(".feed-refresh");
  await expect(btn).toHaveText("↻ refresh");
  await btn.click();
  // the run starts — the button spins
  await expect(btn.locator(".sync-spinner")).toBeVisible();
});
