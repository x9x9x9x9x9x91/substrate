import { expect, test, type Page } from "@playwright/test";

// A dashboard re-reads its own note on every mount, and until that
// read lands the pane draws nothing — so leaving a board and coming straight
// back flashed an empty frame over a body the app was still holding. The pane
// now paints its first frame from the held copy and adopts the fresh read when
// it arrives, so the blank frame is reserved for a genuinely cold read.
//
// Both defect sites are proven here against the deterministic mock backend,
// with the slow-disk instrument (`__mockSetLatency`) standing in for a
// read that takes visibly long: Dashboards/Overview.md (the body-scan pane in
// DashboardPane) and Dashboards/Umbra Home.md (HubDashboard). `.dash-title` is
// the tell — it lives inside the body branch, so seeing it while the read is
// still in flight is exactly "painted without waiting".

/** Leave for a view that is not a dashboard, so the next click is a fresh mount. */
async function leaveTheBoard(page: Page) {
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.locator(".dash-title")).toHaveCount(0);
}

async function slowTheDisk(page: Page, ms: number) {
  await page.evaluate((n) => window.__mockSetLatency!("vault_read", n), ms);
}

for (const board of ["Overview", "Umbra Home"]) {
  test(`${board} repaints from the held body instead of blanking on remount`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".side-item", { hasText: board }).click();
    await expect(page.locator(".dash-title")).toHaveText(board);

    await leaveTheBoard(page);

    // the disk is now slow enough that any pane waiting on its read would sit
    // empty for the rest of the test
    await slowTheDisk(page, 30_000);
    await page.locator(".side-item", { hasText: board }).click();

    // painted from the seed, well inside the 30s read
    await expect(page.locator(".dash-title")).toHaveText(board, { timeout: 3_000 });
  });
}

test("a board this session has never read still shows the honest empty frame", async ({
  page,
}) => {
  await page.goto("/");
  // never opened, so nothing is held for it
  await page.evaluate(() => window.__mockHoldCommand!("vault_read"));
  await page.locator(".side-item", { hasText: "Label Health" }).click();

  // the read is still out; the pane says nothing rather than inventing content
  await page.waitForTimeout(500);
  await expect(page.locator(".dash-title")).toHaveCount(0);

  // and the moment the disk answers, the board appears
  await page.evaluate(() => window.__mockReleaseCommand!("vault_read"));
  await expect(page.locator(".dash-title")).toHaveText("Label Health");
});

test("the seeded paint is replaced by the fresh read, so an edit elsewhere still lands", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-section-label").first()).toHaveText("Releases per month");

  await leaveTheBoard(page);
  // the note changes under the pane while the board is off screen — the seed
  // is a paint, never a source of truth, so the read that follows it wins
  await page.evaluate(() =>
    window.__mockEditNote!(
      "Dashboards/Overview.md",
      "Charts over the label databases.\n\n```chart\nsource: release\nx: status\ny: count\nkind: bar\ntitle: Reconciled after seed\n```\n"
    )
  );

  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-section-label").first()).toHaveText("Reconciled after seed");
});
