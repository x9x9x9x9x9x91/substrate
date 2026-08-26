import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run only:
//   SHOTS=1 SHOT_DIR=/tmp/1496-shots npx playwright test e2e/tablewidthfloorshots.spec.ts
// The jitter itself is a motion fault, so the still that carries it is the
// PAIR: the same windowed table at rest and after scrolling into the middle of
// it. Without the grow-only floors the leftmost columns are visibly narrower in
// the second shot; with them the two frames line up.
//
// Grounds are the app's dark surface plus the print pass — the same split the
// other shot specs use, there being no runtime light theme in src/styles.css.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/1496-shots";

async function shoot(page: Page, name: string) {
  await page.locator(".db-body").screenshot({ path: `${DIR}/${name}-dark.png` });
  // print replaces the app with the print surface, so the pane is shot as a
  // clone inside it — the same route the other print passes take. The clone is
  // re-scrolled to where the original stands, since the whole point of these
  // frames is which columns are how wide at that offset.
  await page.evaluate(() => {
    const found = document.querySelector(".db-body");
    if (!found) throw new Error("no .db-body to clone");
    const box = found.getBoundingClientRect();
    const clone = found.cloneNode(true) as HTMLElement;
    clone.style.width = `${Math.round(box.width)}px`;
    clone.style.height = `${Math.round(box.height)}px`;
    clone.style.overflow = "hidden";
    const surface = document.createElement("div");
    surface.id = "print-surface";
    surface.appendChild(clone);
    document.body.appendChild(surface);
    clone.scrollTop = found.scrollTop;
    clone.scrollLeft = found.scrollLeft;
  });
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(200);
  await page.locator("#print-surface").screenshot({ path: `${DIR}/${name}-print.png` });
  await page.emulateMedia({ media: null });
  await page.evaluate(() => document.getElementById("print-surface")?.remove());
  await page.waitForTimeout(120);
}

async function scrollTo(page: Page, top: number) {
  await page.locator(".db-body").evaluate((el, y) => {
    el.scrollTop = y;
    el.dispatchEvent(new Event("scroll"));
  }, top);
  await page.waitForTimeout(200);
}

test("windowed plugin table: at rest, mid-scroll, and scrolled back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?perfdb=140");
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
  await page.waitForTimeout(300);
  await shoot(page, "01-at-rest");

  await scrollTo(page, 2400);
  await shoot(page, "02-mid-scroll");

  // the return leg: the frame that has to match 01 column for column
  await scrollTo(page, 0);
  await shoot(page, "03-scrolled-back");
});

test("windowed plugin table: scrolled right, then down", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?perfdb=140");
  await openDb(page, "Plugin");
  await expect(page.locator(".db-win-spacer")).not.toHaveCount(0);
  await page.waitForTimeout(300);
  await page.locator(".db-body").evaluate((el) => {
    el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2);
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(200);
  await shoot(page, "04-mid-x");

  await scrollTo(page, 1800);
  await shoot(page, "05-mid-x-scrolled-down");
});
