import { expect, test } from "./fixtures";

// The feed refresh button runs the vault's own `feed-curator` command
// (Settings.md), so it is not a universal affordance — it only
// renders once a command is configured. An unconfigured vault gets the
// in-pane setup card instead of a dead button; saving through that card
// counts as this machine's approval of the command, so the very next click
// dispatches. This spec pins both halves of that gate; the button's own
// behavior lives in feedrefresh.spec.ts.

test("no curator configured → no refresh button, a setup affordance instead", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  // the pane itself renders in full — only the dispatch is gated
  await expect(page.locator(".dash-state")).toContainText("5 items");
  await expect(page.locator(".feed-title").first()).toBeVisible();
  await expect(page.locator(".feed-refresh")).toHaveCount(0);
  await expect(page.locator(".sync-action-err")).toHaveCount(0);
  await expect(page.locator(".feed-setup-btn")).toHaveText("plug in a curator");
});

test("saving a command through the setup card arms the button, and it dispatches", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  await page.locator(".feed-setup-btn").click();
  const dialog = page.locator(".dbform");
  await expect(dialog).toContainText("Plug in a curator");
  // the card documents the contract it is asking a command to honor
  await expect(dialog).toContainText("News Items");
  await expect(dialog).toContainText("feed-curator");
  await dialog.locator(".dbform-input").fill("~/scripts/curate-news.sh");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const btn = page.locator(".feed-refresh");
  await expect(btn).toHaveText("↻ refresh");
  // saved here = approved here: the click dispatches without a trust dialog
  await btn.click();
  await expect(btn.locator(".sync-spinner")).toBeVisible();
});

test("a curator someone else wrote into Settings.md needs this machine's yes", async ({ page }) => {
  await page.goto("/");
  // an agent (or a synced device) writes the key — not this human, not here
  await page.evaluate(() => {
    window.__mockEditProp?.("Settings.md", "feed-curator", "~/scripts/agent-curator.sh");
  });
  await page.locator(".side-item", { hasText: "News" }).click();
  await expect(page.locator(".dash-title")).toHaveText("News");
  const btn = page.locator(".feed-refresh");
  await btn.click();
  // no spawn yet — the trust dialog shows the exact command first
  const dialog = page.locator(".dbform");
  await expect(dialog).toContainText("Run this curator?");
  await expect(dialog.locator(".fm-raw")).toHaveText("~/scripts/agent-curator.sh");
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(btn.locator(".sync-spinner")).toHaveCount(0);
  // a yes runs it — and is remembered, so the next click skips the dialog
  await btn.click();
  await page.locator(".dbform").getByRole("button", { name: "Run" }).click();
  await expect(btn.locator(".sync-spinner")).toBeVisible();
});
