import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run only: SHOTS=1 npx playwright test e2e/groupsectionshots.spec.ts
// SHOT_TAG=before runs the same file at the pre-change sha and keeps only the
// captures that exist there (a grouped table, the bulk bar). The app has no
// runtime light theme (see accentshots.spec.ts), so one ground is the pass.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR ?? "/tmp/groupsection-shots";
const tag = process.env.SHOT_TAG ?? "after";
const before = tag === "before";

async function groupedContacts(page: Page) {
  await page.goto("/");
  await openDb(page, "Contact");
  await expect(page.locator(".db-table")).toBeVisible();
  await page.locator(".db-group-btn").click();
  await page.locator(".selmenu-item", { hasText: "role" }).click();
  await expect(page.locator(".db-group-tr")).toHaveCount(4);
  // the picker's menu is gone before anything is captured
  await page.locator(".list-title").click();
  await page.waitForTimeout(200);
}

function section(page: Page, label: string) {
  return page.locator(".db-group-tr", {
    has: page.locator(".db-group-label", { hasText: label }),
  });
}

test("grouped table at rest", async ({ page }) => {
  await groupedContacts(page);
  await page.screenshot({ path: `${dir}/${tag}-sections-at-rest.png` });
});

test("the bulk bar over a grouped table", async ({ page }) => {
  await groupedContacts(page);
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").click({
    modifiers: ["Meta"],
  });
  await page.locator(".db-table tbody tr", { hasText: "Noa" }).locator(".db-title").click({
    modifiers: ["Meta"],
  });
  await expect(page.locator(".bulkbar")).toContainText("2 selected");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-bulkbar.png` });
});

test("a section folded shut", async ({ page }) => {
  test.skip(before, "no disclosure control at the base sha");
  await groupedContacts(page);
  await section(page, "mix engineer").locator(".db-group-disclose").click();
  await expect(section(page, "mix engineer")).toHaveClass(/is-collapsed/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-section-folded.png` });
});

test("the Move to group… picker open", async ({ page }) => {
  test.skip(before, "no Move to group… action at the base sha");
  await groupedContacts(page);
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").click({
    modifiers: ["Meta"],
  });
  await page.locator(".bulkbar button", { hasText: "Move to group…" }).click();
  await expect(page.locator(".selmenu")).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-move-to-group.png` });
});

test("sections in a hand order", async ({ page }) => {
  test.skip(before, "no draggable sections at the base sha");
  await groupedContacts(page);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await section(page, "radio plugger")
    .locator(".db-group-disclose")
    .dispatchEvent("dragstart", { dataTransfer });
  const target = section(page, "mix engineer");
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await expect(page.locator(".db-group-tr .db-group-label").first()).toContainText("radio plugger");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-hand-order.png` });
});
