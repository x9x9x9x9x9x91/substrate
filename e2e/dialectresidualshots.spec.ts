import { expect, test, type Page } from "@playwright/test";

// Evidence run only: the two dialects this pass corrects — the Vault sync
// pane's failure, which spoke a red line of its own where every board speaks
// the ruled banner, and a charts-keyed board hosting heatmap fences, which
// headed and footed itself as an empty chart board over a page of rendered
// squares.
// The app has no runtime light theme; the light ground is the print pass, and
// the Vault sync pane has no print surface, so it is shot dark only.
//   SHOTS=1 npx playwright test e2e/dialectresidualshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/dialect-shots";
// SHOTS_BEFORE captures the same three states against a build without this
// change, where the sync errors are `.vault-sync-error` lines and the board
// still calls its heatmaps charts.
const before = !!process.env.SHOTS_BEFORE;

const errSel = before ? ".vault-sync-error" : ".dash-alert";

const SESSIONS = [
  "Studio sessions.",
  "",
  "```csv",
  "day,minutes",
  "2025-12-31,10",
  "2026-01-01,20",
  "2026-02-14,40",
  "```",
  "",
].join("\n");

const HEATMAPS = [
  "```heatmap",
  "source: {{Holdings}}",
  "date: day",
  "value: sum:minutes",
  "```",
  "",
  "```heatmap",
  "source: {{Holdings}}",
  "date: day",
  "value: count",
  "```",
  "",
].join("\n");

async function openVaultSync(page: Page) {
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Vault sync", exact: true })
    .click();
  await expect(page.locator(".vault-sync .list-title")).toHaveText("Vault sync");
  await page.getByLabel("Remote URL").fill("https://sync.example.com/ada/vault.git");
  await page.getByLabel("Access token").fill("vault-token-371");
  await page.getByRole("button", { name: "Save remote" }).click();
  await expect(page.locator(".vault-sync-state")).toContainText("Ready");
}

test("shot dark: sync status failure", async ({ page }) => {
  await openVaultSync(page);
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_sync_push"]);
  });
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(`.vault-sync-status ${errSel}`)).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/sync-status-error-dark.png`, fullPage: true });
});

test("shot dark: refused conflict choice", async ({ page }) => {
  await openVaultSync(page);
  await page.getByRole("button", { name: "Pull", exact: true }).click();
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_sync_resolve_set"]);
  });
  await page
    .locator(".sync-conflict-file")
    .filter({ has: page.locator('code:text-is("Journal/2026-07-22.md")') })
    .getByRole("button", { name: "Keep mine" })
    .click();
  await expect(page.locator(`.sync-conflict ${errSel}`)).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/sync-conflict-error-dark.png`, fullPage: true });
});

async function openBoard(page: Page) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([sheet, body]) => {
      window.__mockEditNote!("Holdings.md", sheet!);
      window.__mockEditNote!("Dashboards/Overview.md", body!);
      window.__mockEditProp!("Dashboards/Overview.md", "dashboard", "charts");
    },
    [SESSIONS, HEATMAPS] as const,
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(page.locator(".heatmap-grid").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
}

test("shot dark: a charts-keyed board of heatmaps", async ({ page }) => {
  await openBoard(page);
  await page.screenshot({ path: `${dir}/heatmap-board-dark.png`, fullPage: true });
});

test("shot light (print surface): a charts-keyed board of heatmaps", async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await openBoard(page);
  const printer = page
    .locator("#root .dash-actions")
    .getByRole("button", { name: "Print", exact: true });
  test.skip((await printer.count()) === 0, "this pane has no print surface");
  await printer.click();
  await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/heatmap-board-light.png`, fullPage: true });
});
