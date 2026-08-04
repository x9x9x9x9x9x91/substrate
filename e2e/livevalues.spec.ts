import { expect, test, type Page } from "@playwright/test";

// Live values in prose: an inline code span that starts with `=` renders as the
// value it computes, read out of the sheets. These specs drive the whole chain
// through the real editor — sheet load, evaluation, the chip, the re-render on
// a sheet edit, and the raw span coming back under the cursor.

// cold open lands on Today — one sidebar click to Notes selects the first note
async function boot(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

/* an event within 1s of an app-initiated refresh reads as the own-write echo:
   no immediate refetch, only a trailing one. Wait the window out so the edit
   under test lands promptly. */
async function seedBody(page: Page, path: string, body: string) {
  await page.evaluate(([p, b]) => window.__mockEditNote(p, b), [path, body]);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit("vault:changed"));
}

// Cash.md holds two balances summing to 18000; Holdings.md cross-references it.
const CASH_TWO = `Cash accounts.

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

const CASH_THREE = `Cash accounts.

\`\`\`csv
account,balance_eur
Nordkasse,14200
Brokerhaus,3800
Sparbuch,1000
\`\`\`

\`\`\`formulas
cash_total = SUM(balance_eur)
accounts = COUNT(balance_eur)
\`\`\`
`;

/* The intro line is load-bearing: a fresh doc puts the cursor on line 1, and a
   focused editor reveals its own line's raw source. Keeping the expressions off
   line 1 is what the reader sees anyway — the reveal is exercised on purpose in
   its own spec below. */
const PROSE = "Intro line.\n\nCash on hand is `= Cash.cash_total` across `= Cash.accounts` accounts.\n";

test("an inline `= expr` span renders the value it computes", async ({ page }) => {
  await boot(page);
  await seedBody(page, "Cash.md", CASH_TWO);
  await seedBody(page, "Welcome.md", PROSE);

  const chips = page.locator(".cm-live-value");
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveText("18.000");
  await expect(chips.nth(1)).toHaveText("2");
  // the raw span is gone — the value stands in the sentence, not beside it
  await expect(page.locator(".cm-content")).not.toContainText("Cash.cash_total");
});

test("editing the sheet updates the value in the prose", async ({ page }) => {
  await boot(page);
  await seedBody(page, "Cash.md", CASH_TWO);
  await seedBody(page, "Welcome.md", PROSE);
  await expect(page.locator(".cm-live-value").first()).toHaveText("18.000");

  // a third account lands in the sheet, out of band — the vault epoch bump is
  // the whole invalidation path, exactly as it is for a bound dashboard
  await seedBody(page, "Cash.md", CASH_THREE);

  await expect(page.locator(".cm-live-value").first()).toHaveText("19.000");
  await expect(page.locator(".cm-live-value").nth(1)).toHaveText("3");
});

test("the cursor reveals the raw expression, leaving it renders again", async ({ page }) => {
  await boot(page);
  await seedBody(page, "Cash.md", CASH_TWO);
  await seedBody(page, "Welcome.md", PROSE);

  const chips = page.locator(".cm-live-value");
  await expect(chips).toHaveCount(2);

  // click on the expression's own line: source mode, both spans raw
  await page.locator(".cm-content").getByText("Cash on hand is").click();
  await expect(chips).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("= Cash.cash_total");

  // and a cursor elsewhere renders them back
  await page.locator(".cm-content").getByText("Intro line.").click();
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveText("18.000");
});

test("an expression nothing backs fails quietly, with the reason on hover", async ({ page }) => {
  await boot(page);
  await seedBody(page, "Welcome.md", "Intro line.\n\nNothing here: `= Nowhere.total`.\n");

  const chip = page.locator(".cm-live-value");
  await expect(chip).toHaveText("–");
  await expect(chip).toHaveClass(/cm-live-error/);
  // the detail rides the tooltip rather than the sentence
  await expect(chip).toHaveAttribute("title", /Nowhere/);
});

test("`=SUM(A1:A2)` in a sentence stays literal", async ({ page }) => {
  // Prose ABOUT spreadsheets is prose. Nothing computes, nothing is replaced,
  // and the sentence the writer typed is the sentence on screen.
  await boot(page);
  await seedBody(
    page,
    "Welcome.md",
    "Intro line.\n\nIn Excel you write `=SUM(A1:A2)` to total two cells.\n"
  );

  await expect(page.locator(".cm-live-value")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText(
    "In Excel you write =SUM(A1:A2) to total two cells."
  );
});

test("`= SUM(A1:A2)` renders the literal span when it cannot parse", async ({ page }) => {
  // The space-form collision: it looks like a live value, but `A1:A2` is not
  // sheet syntax. The span keeps rendering as the code it is — the dim dash is
  // only ever for expressions that PARSE and then fail to evaluate, so no
  // input can turn a reader's own words into a dash.
  await boot(page);
  await seedBody(
    page,
    "Welcome.md",
    "Intro line.\n\nThe old sheet said `= SUM(A1:A2)` at the bottom.\n"
  );

  await expect(page.locator(".cm-live-value")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("SUM(A1:A2)");
});
