import { expect, test, type Page } from "@playwright/test";

// Throwaway evidence run that photographs the calc line and the live-value
// popup for review — not a gate.
//   SHOTS=1 npx playwright test e2e/calcaffordanceshots.spec.ts
// One pass, not a light/dark pair: styles.css carries no prefers-color-scheme
// block and the app has no theme switch, so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const menu = ".cm-tooltip-autocomplete";
const OUT = "/tmp/sub1248-shots";

/** Notes → Welcome, then a fresh last line to type on. */
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.locator(".cm-content").click();
  const lines = page.locator(".cm-line");
  const before = await lines.count();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(lines).toHaveCount(before + 1);
}

test("shot: palette showing /calc and /live", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("/c");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/palette.png` });
});

test("shot: sheet stage of the name popup", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("`= ");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/sheets.png` });
});

test("shot: member stage, summaries first", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("`= Cash.");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/members.png` });
});

test("shot: the completed value in the sentence", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("Cash on hand is `= Cash.cash_total` today.");
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.locator(".cm-live-value").last()).toHaveText("18.000");
  await page.screenshot({ path: `${OUT}/value.png` });
});

test("shot: a calc line and its answer", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("= 20kg in lb");
  await expect(page.locator(".cm-calc-result")).toBeVisible();
  await page.screenshot({ path: `${OUT}/calc.png` });
});
