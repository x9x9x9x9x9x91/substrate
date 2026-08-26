import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run only (SHOTS=1): the table's Name cell through the gesture that
// changed. A plain click used to open the note's foldout, which made the Name
// column the one column you could not type into; it now opens an inline
// rename editor, and the foldout answers to double-click and Enter. These
// shots are the LOOK of that: the cell at rest, the editor open in its place,
// a draft mid-typing, and the foldout the double-click still opens.
//
// Both grounds here means both ACCENT TONES (appearance.ts): the app has no
// runtime light theme — styles.css carries no [data-theme] rule at all.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOTS_DIR || "/tmp/lane-shots-1398";

test.use({ viewport: { width: 1400, height: 900 } });

async function setTone(page: Page, tone: "sky" | "violet") {
  await page.evaluate((t) => {
    document.documentElement.dataset.tone = t;
  }, tone);
  await page.waitForTimeout(150);
}

async function shoot(page: Page, name: string) {
  for (const tone of ["sky", "violet"] as const) {
    await setTone(page, tone);
    await page.screenshot({ path: `${DIR}/${name}-${tone}.png` });
  }
  await setTone(page, "sky");
}

test("the Name cell at rest, renaming, and the foldout the double-click opens", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  const cell = page.locator("td.db-title").first();
  await expect(cell).toBeVisible();
  await shoot(page, "01-at-rest");

  // a plain click: the editor takes the title's exact place
  await cell.click();
  const input = page.locator("input.db-title-edit");
  await expect(input).toBeVisible();
  await shoot(page, "02-click-renames");

  // mid-draft — a long name is where a clipped or overflowing box would show
  await input.fill("A considerably longer release name");
  await shoot(page, "03-draft-typed");

  // Escape drops the draft; the row keeps the name it had
  await input.press("Escape");
  await expect(page.locator("input.db-title-edit")).toHaveCount(0);
  await shoot(page, "04-escaped");

  // the foldout, now on double-click
  await cell.dblclick();
  await expect(page.locator(".db-note .note-title")).toBeVisible();
  await shoot(page, "05-dblclick-opens");
});
