import { expect, test } from "@playwright/test";

// A dashboard kind that no longer exists (retired `waiting`, and the tile
// board whose span the hub now carries) must get
// the honest unknown-kind card, not blow the pane up and not morph
// into a different tracker. Notes on disk outlive the code that rendered
// them, so this is the contract for every kind that is ever removed.
test("a note with a retired dashboard kind renders the unknown-kind card", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Calories.md", "Dashboards/Retired Kind.md");
    window.__mockEditProp?.("Dashboards/Retired Kind.md", "dashboard", "waiting");
    window.__mockEmit?.("vault:changed");
  });

  await page.locator(".side-item", { hasText: "Retired Kind" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Retired Kind");
  await expect(page.locator(".dash-state")).toHaveText("unknown kind");
  await expect(page.locator(".dash-alert")).toContainText("waiting");
});

// Same contract for the tile board: its span capability moved onto the hub
// callout, so a vault still carrying the old kind falls through to the card
// rather than losing its note.
test("a note kept on the retired tile-board kind renders the unknown-kind card", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Calories.md", "Dashboards/Old Board.md");
    window.__mockEditProp?.("Dashboards/Old Board.md", "dashboard", "grid");
    window.__mockEmit?.("vault:changed");
  });

  await page.locator(".side-item", { hasText: "Old Board" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Old Board");
  await expect(page.locator(".dash-state")).toHaveText("unknown kind");
  await expect(page.locator(".dash-alert")).toContainText("grid");
});
