import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.SHOTS, "evidence run only");
const menu = ".cm-tooltip-autocomplete";
const OUT = "/tmp/sub1272-shots";

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

test("shot: /cal menu", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("/cal");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/cal-menu.png` });
});

test("shot: long span still completes", async ({ page }) => {
  await boot(page);
  await page.keyboard.type("`= ");
  await page.keyboard.insertText("1 + ".repeat(80));
  await page.keyboard.type("Ca");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${OUT}/long-span.png` });
});

const CASH = `Cash accounts.

\`\`\`csv
account,balance_eur
Nordkasse,14200
Brokerhaus,3800
\`\`\`

\`\`\`formulas
cash_total = SUM(balance_eur)
accounts = COUNT(balance_eur)
\`\`\`
`;

async function seedBody(page: Page, path: string, body: string) {
  await page.evaluate(([p, b]) => window.__mockEditNote(p, b), [path, body]);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

test("shot: value after an external adopt", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await seedBody(page, "Cash.md", CASH);

  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a line that mentions no sheet at all");
  await page.waitForTimeout(700);

  await seedBody(
    page,
    "Welcome.md",
    "Intro line.\n\nCash on hand is `= Cash.cash_total` across `= Cash.accounts` accounts.\n"
  );

  await expect(page.locator(".cm-live-value").first()).toHaveText("18.000");
  await expect(page.locator(".cm-live-value").nth(1)).toHaveText("2");
  await page.screenshot({ path: `${OUT}/external-adopt.png` });
});
