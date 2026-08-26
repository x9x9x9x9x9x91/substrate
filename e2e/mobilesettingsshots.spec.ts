import { test, type Page } from "./fixtures";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/settings-mobile npx playwright test e2e/mobilesettingsshots.spec.ts
// Shoots the two surfaces the phone's route into Settings adds: the drawer
// carrying the new row, and the sheet it raises, at 390×844.
//
// Grounds, the split the other shot specs take (e2e/accentshots.spec.ts):
// dark is the app as it runs, and since there is no runtime light theme in
// src/styles.css, "light" is the print pass — the live surface cloned into
// #print-surface with print media emulated.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/settings-mobile-shots";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function shoot(page: Page, selector: string, name: string) {
  await page.locator(selector).screenshot({ path: `${DIR}/${name}-dark.png` });
  await page.evaluate((sel) => {
    const found = document.querySelector(sel);
    if (!found) throw new Error(`no ${sel} to clone`);
    const box = found.getBoundingClientRect();
    const clone = found.cloneNode(true) as HTMLElement;
    // The phone's surfaces are slid or fixed into place; the print surface is
    // an ordinary block, so the clone stands still at the size it just had.
    clone.style.position = "static";
    clone.style.transform = "none";
    clone.style.visibility = "visible";
    clone.style.width = `${Math.round(box.width)}px`;
    clone.style.height = `${Math.round(box.height)}px`;
    const surface = document.createElement("div");
    surface.id = "print-surface";
    surface.appendChild(clone);
    document.body.appendChild(surface);
  }, selector);
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(200);
  await page.locator("#print-surface").screenshot({ path: `${DIR}/${name}-light.png` });
  await page.emulateMedia({ media: null });
  await page.evaluate(() => document.getElementById("print-surface")?.remove());
}

test("shots: the drawer's Settings row and the sheet it raises", async ({ page }) => {
  await page.goto("/");
  await page.locator(".mobile-menu").click();
  await page.locator(".sidebar .side-bottom .side-item", { hasText: /^Settings$/ }).waitFor();
  await page.waitForTimeout(300);
  await shoot(page, ".sidebar", "drawer-mobile");

  await page.locator(".sidebar .side-bottom .side-item", { hasText: /^Settings$/ }).click();
  await page.locator(".settings-sheet").waitFor();
  await page.waitForTimeout(400);
  await shoot(page, ".settings-sheet", "settings-mobile");
});

// One per tab as well: the sideways slide this pass was chasing lives in a
// single row's control column, and only the tab holding it shows it.
for (const tab of ["appearance", "terminal", "sharing", "vault"]) {
  test(`shots: settings sheet on the ${tab} tab`, async ({ page }) => {
    await page.goto("/");
    await page.locator(".mobile-menu").click();
    await page.locator(".sidebar .side-bottom .side-item", { hasText: /^Settings$/ }).click();
    await page.locator(".settings-sheet").waitFor();
    await page.locator(`#settings-tab-${tab}`).click();
    await page.waitForTimeout(400);
    await shoot(page, ".settings-sheet", `settings-mobile-${tab}`);
  });
}
