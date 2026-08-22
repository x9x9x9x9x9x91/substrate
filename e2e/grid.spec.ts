import { expect, test } from "@playwright/test";

const GRID_BODY = `A composed board.

\`\`\`tile
tile: cards
source: {{Holdings}}
cards: Total value = total | eur | emph, Crypto = crypto | eur
\`\`\`

\`\`\`tile
tile: chart
source: release
x: status
y: count
kind: bar
title: Releases by status
\`\`\`

\`\`\`tile
tile: cards
source: {{Holdings}}
cards: ETF = etf | eur | emph, Rest = total | eur
\`\`\`

\`\`\`tile
tile: view
type: release
query: status:mastering
span: 2
\`\`\`

\`\`\`tile
tile: chart
source: release
x: status
\`\`\`
`;

test("grid composes all tile kinds and isolates a malformed sibling (SUB-940)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((body) => {
    window.__mockTraceCommands?.();
    window.__mockEditProp!("Dashboards/Overview.md", "dashboard", "grid");
    window.__mockEditNote!("Dashboards/Overview.md", body);
    window.__mockEmit!("vault:changed");
  }, GRID_BODY);

  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(page.locator(".grid-tile")).toHaveCount(5);
  // one authored span, plus the two tiles this board strands on a row of
  // their own: tile 3 because the authored span-2 after it cannot
  // share its row, and tile 5 because it is last with an odd count.
  await expect(page.locator(".grid-tile.span-2")).toHaveCount(3);
  await expect(page.locator(".grid-tile").nth(0)).not.toHaveClass(/span-2/);
  await expect(page.locator(".grid-tile").nth(1)).not.toHaveClass(/span-2/);
  await expect(page.locator(".grid-tile").nth(2)).toHaveClass(/span-2/);
  await expect(page.locator(".grid-tile").nth(3)).toHaveClass(/span-2/);
  await expect(page.locator(".grid-tile").nth(4)).toHaveClass(/span-2/);

  await expect(page.locator(".grid-tile .dash-card")).toHaveCount(4);
  await expect(page.locator(".grid-tile .dash-card:not(.sunk)")).toHaveCount(2);
  await expect(page.locator(".grid-tile .dash-card", { hasText: "Rest" }).locator(".dash-card-eur")).not.toHaveText("—");
  await expect(page.locator(".dash-section-label", { hasText: "Releases by status" })).toBeVisible();
  await expect(page.locator(".grid-tile .dash-bar-col")).not.toHaveCount(0);
  await expect(page.locator(".grid-tile .embed-view-table tbody tr")).not.toHaveCount(0);
  await expect(page.locator(".dash-alert")).toHaveText('missing required key "y"');
  const holdingsReads = await page.evaluate(() =>
    (window.__mockReadCommandTrace?.() as Array<{ cmd?: string; path?: string }> ?? [])
      .filter((entry) => entry.cmd === "vault_read" && entry.path === "Holdings.md").length
  );
  expect(holdingsReads).toBe(1);
});
