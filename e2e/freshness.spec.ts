import { expect, test, type Page } from "./fixtures";

// The freshness column: `age(prop)` beside a value in a view fence, over the
// mock's review windows (a contact's email is worth re-checking every 90 days,
// a phone about once a year) and the ages the mock history reports.
//
// Pull-only, like everything the review windows feed: the column answers a
// question the fence asked and nothing else. It is asserted by STATE rather
// than by row, because what the column claims is that the four answers a
// reader can meet — inside the window, nearing it, past it, and one nobody
// can date — look different from each other.

const FENCE =
  "Who to re-check.\n\n```view\ntype: contact\ncolumns: title, email, age(email)\nview: table\n```\n";

async function openColumn(page: Page) {
  await page.goto("/");
  // Notes opens Welcome, which the seed leaves free for a spec to rewrite
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.evaluate((body) => {
    window.__mockEditNote?.("Welcome.md", body);
  }, FENCE);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
  // the ages arrive after the table paints — wait for a filled cell
  await expect(page.locator(".embed-view-age").first()).toBeVisible({ timeout: 10_000 });
}

test("each value's age stands beside it, tinted by how it stands to its window", async ({
  page,
}) => {
  await openColumn(page);

  // past the window and nearing it are the two the tint exists for
  await expect(page.locator(".embed-view-age-due")).not.toHaveCount(0);
  await expect(page.locator(".embed-view-age-aging")).not.toHaveCount(0);
  // …and a value the history has nobody behind is a dash, never a guess
  const unknown = page.locator(".embed-view-age-unknown");
  await expect(unknown).not.toHaveCount(0);
  await expect(unknown.first()).toHaveText("—");
});

test("the cell says whose age it is and what the schema asked of it", async ({ page }) => {
  await openColumn(page);
  await expect(page.locator(".embed-view-age-due").first()).toHaveAttribute(
    "title",
    /email: last set by hand · reviewed every 90 days/
  );
  // the silence names WHICH silence it is
  await expect(page.locator(".embed-view-age-unknown").first()).toHaveAttribute(
    "title",
    /import|no history/
  );
});

// Evidence run, not a gate: SHOTS=1 npx playwright test e2e/freshness.spec.ts
const OUT = process.env.SHOTS_DIR || "/tmp/lane-reports/shots-freshness";

test("shot: a freshness column in a view fence", async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  await openColumn(page);
  await page.screenshot({ path: `${OUT}/freshness-column.png` });
});

test("shot: the kind picker, with no report to pick", async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("dashboard");
  await page.locator(".palette-item", { hasText: "New dashboard…" }).first().click();
  await expect(page.locator(".palette-item").first()).toBeVisible();
  await page.locator(".palette-input").fill("shelf");
  await page.screenshot({ path: `${OUT}/kind-picker.png` });
});
