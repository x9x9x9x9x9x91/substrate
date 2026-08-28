import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/db-polish npx playwright test e2e/dbpolishshots.spec.ts
// Shoots the database views the polish pass touches: the table's Name column
// and header row (resting and scrolled right, where the frozen column has to
// keep its own content and its freeze cue), and a board column's cards. What
// the shots are for is the questions the self-check asks — does the row mark
// crowd the title, does the header keep its height with a glyph in it, does a
// card's preview line clip cleanly at two lines.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/db-polish";

test.use({ viewport: { width: 1400, height: 900 } });

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

test("table: name column and header row, resting and scrolled", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Ledger");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator(".db-table")).toBeVisible();
  await shoot(page, "table-rest");

  const body = page.locator(".db-body");
  await body.evaluate((el) => {
    el.scrollLeft = 600;
  });
  await expect(body).toHaveClass(/db-scrolled-x/);
  await shoot(page, "table-scrolled");
});

test("board: cards with their mark, subtitle and preview line", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".db-card").first()).toBeVisible();
  await shoot(page, "board");
});
