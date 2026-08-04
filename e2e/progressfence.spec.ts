import { expect, test, type Page } from "@playwright/test";

// Progress fence — the goal thermometer (SUB-967). A ```progress fence puts one
// number against the number it should reach, and reads identically on both
// surfaces it can live on.
//
// Fixtures (src/lib/tauri.ts): Dashboards/Goals.md is a hub whose body contains
// the three fence shapes — a sheet bind with a full pace line (deadline
// + start anchor), a `value: count` over the contact database, and a malformed
// fence that must error in place. Dashboards/Umbra Home.md (the hub) carries the
// same two shapes interleaved with its views, cards and charts, plus a third
// inside a callout body that must stay a code box (SUB-964's rule). Deadlines in
// the fixtures are relative to today, so the pace line can't rot.

async function openGoals(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Goals" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Goals");
}

test("the standalone board draws a bar, the reading and the pace line", async ({ page }) => {
  await openGoals(page);

  const fences = page.locator(".hub-body .hub-progress");
  await expect(fences).toHaveCount(3);

  // the bound fence: the sheet summary resolves the way it does on a card,
  // formatted in the same money voice
  const bound = fences.nth(0);
  await expect(bound.locator(".dash-label")).toHaveText("Portfolio target");
  await expect(bound.locator(".progress-read")).toHaveText(/of 500\.000 €$/);
  await expect(bound.locator(".progress-pct")).toHaveText(/^\d+%$/);

  // the bar is a picture of that number, and the picture carries the reading
  // for anyone who can't see it
  const track = bound.locator(".progress-track");
  await expect(track).toHaveAttribute("role", "progressbar");
  await expect(track).toHaveAttribute("aria-valuemax", "500000");
  await expect(track).toHaveAttribute("aria-label", "Portfolio target");
  await expect(track).toHaveAttribute("aria-valuetext", /of 500\.000 €/);
  await expect(bound.locator(".progress-fill")).toBeVisible();

  // deadline + start anchor: the fence may claim ahead/behind, and says how
  // long is left
  await expect(bound.locator(".progress-foot")).toHaveText(
    /(ahead by|behind by|on pace|target reached).*days left/
  );
});

test("a count fence counts the database the same way a view fence does", async ({ page }) => {
  await openGoals(page);

  const count = page.locator(".hub-body .hub-progress").nth(1);
  await expect(count.locator(".dash-label")).toHaveText("Contacts logged");
  // four contact notes in the mock vault, against a target of eight
  await expect(count.locator(".progress-read")).toHaveText("4 of 8");
  await expect(count.locator(".progress-pct")).toHaveText("50%");
  await expect(count.locator(".progress-track")).toHaveAttribute("aria-valuenow", "4");
  // no deadline, so no pace line is claimed at all
  await expect(count.locator(".progress-foot")).toHaveCount(0);
});

test("a malformed fence errors in place while its siblings render", async ({ page }) => {
  await openGoals(page);

  const broken = page.locator(".hub-body .hub-progress").nth(2);
  await expect(broken.locator(".progress-err")).toHaveText(/value: count needs a source/);
  await expect(broken.locator(".progress-track")).toHaveCount(0);

  // the two above it are untouched
  await expect(page.locator(".hub-body .hub-progress .progress-track")).toHaveCount(2);
  await expect(page.locator(".hub-body .hub-progress").nth(0).locator(".progress-read")).toBeVisible();
  await expect(page.locator(".hub-body .hub-progress").nth(1).locator(".progress-read")).toHaveText(
    "4 of 8"
  );
});

test("a hub body hosts the same thermometer between its other blocks", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");

  const fences = page.locator(".hub-body .hub-progress");
  await expect(fences).toHaveCount(2);

  // same contract as the standalone board: same label, same reading, same bar
  const bound = fences.nth(0);
  await expect(bound.locator(".dash-label")).toHaveText("Portfolio target");
  await expect(bound.locator(".progress-read")).toHaveText(/of 500\.000 €$/);
  await expect(bound.locator(".progress-track")).toHaveAttribute("role", "progressbar");
  // deadline without a start anchor: days left and the rate still required,
  // and no ahead/behind claim the vault can't back
  await expect(bound.locator(".progress-foot")).toHaveText(/days left · .*\/day to go/);
  await expect(bound.locator(".progress-foot")).not.toContainText("behind by");
  await expect(bound.locator(".progress-foot")).not.toContainText("ahead by");

  // the broken fence errors in place; the hub's other surfaces are untouched
  await expect(fences.nth(1).locator(".progress-err")).toHaveText(/value: count needs a source/);
  await expect(page.locator(".hub-body .metrics-strip .dash-card")).toHaveCount(3);
  await expect(page.locator(".hub-body .hub-view .embed-view-table")).toHaveCount(1);

  // and neither live progress fence fell through to a code box — the page's
  // code boxes are still only the deliberately quoted/callout-nested fences
  // (SUB-964), one of which is a progress fence inside the [!idea] callout
  await expect(page.locator(".hub-body .hub-pre")).toHaveCount(4);
  await expect(page.locator(".hub-body > .hub-pre")).toHaveCount(0);
  await expect(page.locator(".hub-card-idea .hub-progress")).toHaveCount(0);
  await expect(page.locator(".hub-card-idea .hub-pre", { hasText: "label: Nested goal" })).toHaveCount(
    1
  );
});
