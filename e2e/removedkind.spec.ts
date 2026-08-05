import { expect, test } from "@playwright/test";

// A dashboard kind that no longer exists (retired `waiting`) must get
// the honest unknown-kind card, not blow the pane up and not morph
// into a different tracker. Notes on disk outlive the code that rendered
// them, so this is the contract for every kind that is ever removed.
test("a note with a retired dashboard kind renders the unknown-kind card", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Yield APR.md", "Dashboards/Retired Kind.md");
    window.__mockEditProp?.("Dashboards/Retired Kind.md", "dashboard", "waiting");
    window.__mockEmit?.("vault:changed");
  });

  await page.locator(".side-item", { hasText: "Retired Kind" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Retired Kind");
  await expect(page.locator(".dash-state")).toHaveText("unknown kind");
  await expect(page.locator(".chart-err")).toContainText("waiting");
});
