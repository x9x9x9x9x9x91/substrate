import { test, type Page } from "./fixtures";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test e2e/tasksdashshots.spec.ts
// One full-window shot of the Tasks board over the mock seed, so a
// board-touching branch's before/after pass can be judged as a page. The
// selectors stay surface-level on purpose: the same spec must shoot the board
// on either side of a section rename.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/tasksdash-shots";

async function openTasks(page: Page) {
  await page.goto("/");
  // the Tasks DATABASE row carries a DB chip; the dashboard row doesn't
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await page.locator(".dash-title").waitFor();
}

test("tasks board, one page", async ({ page }) => {
  await openTasks(page);
  // let chips and counts settle before the picture
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/tasksboard.png` });
});
