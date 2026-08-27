import { expect, test, type Page } from "./fixtures";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/1544-shots npx playwright test e2e/designdriftshots.spec.ts
//
// The surfaces the design-lint pass touched, one shot each, so the before and
// after builds can be read side by side: provenance footers that used to chain
// their facts with middots, the three toggle groups that used to be pills, the
// settings sheet's section headings, the workbook's sibling pages, and the food
// strip that drew two units without naming either.
//
// Dark only. The panes here are status surfaces (proxy, feed, settings sheet)
// with no print story, and the change under evidence is layout and type voice,
// which the print clone renders from the same rules.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/1544-shots";

const open = async (page: Page, item: string | RegExp, ready: string) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: item }).first().click();
  await expect(page.locator(ready).first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
};

const shoot = async (page: Page, slug: string) => {
  await page.screenshot({ path: `${DIR}/${slug}.png`, fullPage: true });
};

test("food: strip units, hero sub-lines, database head meta, footer", async ({ page }) => {
  await open(page, "Calories", ".food-strip");
  await shoot(page, "food");
});

test("proxy: window toggles, period toggles, sort, token and poll footers", async ({ page }) => {
  await open(page, "Proxy", ".proxy-tokens-head");
  await shoot(page, "proxy");
});

test("feed: topic filter and head", async ({ page }) => {
  await open(page, "News", ".feed-filter");
  await shoot(page, "feed");
});

test("sync: summary and footer", async ({ page }) => {
  // two sidebar rows say "sync" — the seeded board and the app's vault-sync
  // surface — so this one is pinned to the whole word
  await open(page, /^Sync$/, ".dash-inner");
  await shoot(page, "sync");
});

test("mastering: loudness triple, bucket verdicts, footer", async ({ page }) => {
  await open(page, "Mastering", ".dash-inner");
  await shoot(page, "mastering");
});

test("listening queue: summary and footer", async ({ page }) => {
  await open(page, "Listening", ".dash-inner");
  await shoot(page, "listening");
});

test("workbook: the sheet page and the error page", async ({ page }) => {
  await open(page, "Label Books", ".wb-tabs");
  await page.locator(".wb-tab", { hasText: "Cash" }).click();
  await expect(page.locator(".sheet")).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, "workbook-sheet");

  await page.locator(".wb-tab", { hasText: "Releases" }).click();
  await expect(page.locator(".wb-view-table")).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, "workbook-view");

  await page.locator(".wb-tab", { hasText: "Broken" }).click();
  await expect(page.locator(".wb-page-err")).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, "workbook-error");
});

test("settings: the sheet's section headings", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet").first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await shoot(page, "settings");
});

test("share door: the mode row", async ({ page }) => {
  await page.goto("/");
  await page.locator(".list .row", { hasText: "Welcome" }).first().click({ button: "right" });
  await page.locator(".ctx-menu").getByText("Share…").click();
  await expect(page.locator(".dbform")).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(400);
  await shoot(page, "share-door");
});
