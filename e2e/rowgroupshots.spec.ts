import { expect, test, type Page, type Locator } from "./fixtures";
import { openDb } from "./nav";

// Evidence run only: SHOTS=1 npx playwright test e2e/rowgroupshots.spec.ts
// SHOT_TAG=before runs the same file at the pre-change sha and keeps only the
// captures that exist there (the table at rest), which is what says whether
// anything unrelated moved. The app has no runtime light theme (see
// accentshots.spec.ts), so one ground is the pass.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOT_DIR ?? "/tmp/rowgroup-shots";
const tag = process.env.SHOT_TAG ?? "after";
const before = tag === "before";

async function contacts(page: Page, grouped: boolean) {
  await page.goto("/");
  await openDb(page, "Contact");
  await expect(page.locator(".db-table")).toBeVisible();
  if (grouped) {
    await page.locator(".db-group-btn").click();
    await page.locator(".selmenu-item", { hasText: "role" }).click();
    await expect(page.locator(".db-group-tr").first()).toBeVisible();
    // the picker's menu is gone before anything is captured
    await page.locator(".list-title").click();
  }
  await page.waitForTimeout(200);
}

function row(page: Page, name: string): Locator {
  return page.locator(".db-table tbody tr", { hasText: name }).first();
}

/** the gesture up to the release: grab one row, hold the pointer over the
    MIDDLE of another. Only that band reads as "group these two". */
async function hoverRowOntoRow(page: Page, from: string, onto: string) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const src = row(page, from);
  const dst = row(page, onto);
  await src.dispatchEvent("dragstart", { dataTransfer });
  const box = await dst.boundingBox();
  const clientY = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await dst.dispatchEvent("dragover", { dataTransfer, clientY });
  return { dataTransfer, dst };
}

async function dropRowOntoRow(page: Page, from: string, onto: string) {
  const { dataTransfer, dst } = await hoverRowOntoRow(page, from, onto);
  const box = await dst.boundingBox();
  const clientY = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await dst.dispatchEvent("drop", { dataTransfer, clientY });
}

test("grouped table at rest", async ({ page }) => {
  await contacts(page, true);
  await page.screenshot({ path: `${dir}/${tag}-grouped-at-rest.png` });
});

test("a row held over the middle of another row", async ({ page }) => {
  test.skip(before, "no row-onto-row drop target at the base sha");
  await contacts(page, true);
  await hoverRowOntoRow(page, "Gero", "Noa");
  await expect(page.locator("tr.row-group-drop")).toHaveCount(1);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-drop-target-lit.png` });
});

test("the naming prompt over a grouped table", async ({ page }) => {
  test.skip(before, "no naming prompt at the base sha");
  await contacts(page, true);
  await dropRowOntoRow(page, "Gero", "Noa");
  await expect(page.locator('[role="dialog"][aria-label="Group these rows"]')).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-prompt-grouped.png` });
});

test("the naming prompt establishing a grouping", async ({ page }) => {
  test.skip(before, "no naming prompt at the base sha");
  // ungrouped on purpose: the prompt grows its property step
  await contacts(page, false);
  await dropRowOntoRow(page, "Gero", "Noa");
  const dialog = page.locator('[role="dialog"][aria-label="Group these rows"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[aria-label="Group by property"]')).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-prompt-establish.png` });

  // and the same prompt with a new property named, which is its tallest form
  await dialog.locator('[aria-label="Group by property"]').selectOption("");
  await expect(dialog.locator('[aria-label="New property name"]')).toBeVisible();
  await dialog.locator('[aria-label="Group name"]').fill("Touring");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-prompt-new-property.png` });
});

test("the prompt refusing a name the app keeps for itself", async ({ page }) => {
  test.skip(before, "no naming prompt at the base sha");
  await contacts(page, false);
  await dropRowOntoRow(page, "Gero", "Noa");
  const dialog = page.locator('[role="dialog"][aria-label="Group these rows"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[aria-label="Group by property"]').selectOption("");
  // `type` is never a column, so nothing above the field can refuse it — a
  // property by that name would retype both rows out of the database
  await dialog.locator('[aria-label="New property name"]').fill("type");
  await dialog.locator('[aria-label="Group name"]').fill("Touring");
  await expect(dialog.locator(".dbform-err")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Group" })).toBeDisabled();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/${tag}-prompt-reserved-refusal.png` });
});
