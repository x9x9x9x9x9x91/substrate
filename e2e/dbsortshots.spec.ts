import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/sort-shots npx playwright test e2e/dbsortshots.spec.ts
// Shoots the database tab row's sort tool in the states worth judging: resting
// with a key count on the trigger, open on the add list, and open on the
// two-key sort the headers build. The "before" shot is the same tab row on an
// unsorted view, which is what the surface looked like before this tool
// existed.
//
// Grounds, the split the other pane shot specs use: dark is the app as it runs
// (there is no runtime light theme), "light" is the print pass over a clone —
// printing the live page hides the app shell, so the clone is what carries the
// panel onto paper tokens.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/sort-shots";

async function shoot(page: Page, name: string, cloneSel: string) {
  // the panel pops in over 100ms — shoot it at rest, not mid-animation
  await page.waitForTimeout(250);
  await page.screenshot({
    path: `${DIR}/sort-${name}-dark.png`,
    clip: { x: 240, y: 40, width: 1160, height: 420 },
  });
  await page.evaluate((sel) => {
    const found = document.querySelector(sel);
    if (!found) throw new Error(`no ${sel} to clone`);
    const box = found.getBoundingClientRect();
    const clone = found.cloneNode(true) as HTMLElement;
    clone.style.width = `${Math.round(box.width)}px`;
    clone.style.position = "static";
    const surface = document.createElement("div");
    surface.id = "print-surface";
    surface.appendChild(clone);
    document.body.appendChild(surface);
  }, cloneSel);
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(200);
  await page.locator("#print-surface").screenshot({ path: `${DIR}/sort-${name}-light.png` });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => document.getElementById("print-surface")?.remove());
}

test.use({ viewport: { width: 1400, height: 900 } });

test("the sort popover, five states, both grounds", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.locator(".db-table")).toBeVisible();

  // 1. before: an unsorted tab row, the trigger quiet
  await shoot(page, "unsorted", ".db-tools");

  // 2. the add list, reached from an unsorted view
  await page.locator(".db-sorts-btn").click();
  await expect(page.locator(".db-sorts-add-item").first()).toBeVisible();
  await shoot(page, "addlist", ".db-sorts-menu");

  // 3. the overview, on the two-key sort the headers build
  await page.keyboard.press("Escape");
  await page.locator(".db-th-label", { hasText: "Status" }).click();
  await page.locator(".db-th-label", { hasText: "Released" }).click({ modifiers: ["Shift"] });
  await page.locator(".db-sorts-btn").click();
  await expect(page.locator(".db-sorts-row")).toHaveCount(2);
  await shoot(page, "twokeys", ".db-sorts-menu");

  // 4. the add list under a live key list — the face that used to replace it
  await page.locator(".db-sorts-add").click();
  await expect(page.locator(".db-sorts-add-item").first()).toBeVisible();
  await shoot(page, "adding", ".db-sorts-menu");

  // 5. resting: the count on the trigger is the whole report when closed
  await page.keyboard.press("Escape");
  await expect(page.locator(".db-sorts-count")).toHaveText("2");
  await shoot(page, "resting", ".db-tools");
});
