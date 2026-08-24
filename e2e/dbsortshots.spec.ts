import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/sort-shots npx playwright test e2e/dbsortshots.spec.ts
// Shoots the database tab row's sort tool in the three states worth judging:
// resting with a key count on the trigger, open on a two-key sort, and open on
// the add list. The "before" shot is the same tab row on an unsorted view,
// which is what the surface looked like before this tool existed.
//
// Two grounds, the way the other pane shots take them. Dark is the app as it
// runs; "light" is the print pass — there is no runtime light theme, and
// `@media print` is what remaps the dark token ramp onto a paper palette.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/sort-shots";

async function shoot(page: Page, name: string) {
  const clip = { x: 0, y: 0, width: 1400, height: 320 };
  await page.screenshot({ path: `${DIR}/sort-${name}-dark.png`, clip });
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${DIR}/sort-${name}-light.png`, clip });
  await page.emulateMedia({ media: null });
}

test.use({ viewport: { width: 1400, height: 900 } });

test("the sort popover, three states, both grounds", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator(".db-table")).toBeVisible();

  // 1. before: an unsorted tab row, the trigger quiet
  await shoot(page, "unsorted");

  // 2. the add list, reached from an unsorted view
  await page.locator(".db-sorts-btn").click();
  await expect(page.locator(".db-sorts-add-item").first()).toBeVisible();
  await shoot(page, "addlist");

  // 3. the overview, on the two-key sort the headers build
  await page.keyboard.press("Escape");
  await page.locator(".db-th-label", { hasText: "Status" }).click();
  await page.locator(".db-th-label", { hasText: "Released" }).click({ modifiers: ["Shift"] });
  await page.locator(".db-sorts-btn").click();
  await expect(page.locator(".db-sorts-row")).toHaveCount(2);
  await shoot(page, "twokeys");

  // 4. resting: the count on the trigger is the whole report when closed
  await page.keyboard.press("Escape");
  await expect(page.locator(".db-sorts-count")).toHaveText("2");
  await shoot(page, "resting");
});
