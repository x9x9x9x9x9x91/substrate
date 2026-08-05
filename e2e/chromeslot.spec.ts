import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// The keyboard button holds one coordinate across every desktop
// surface — asserted here against the widest sweep of them (keyhints.spec.ts
// gates the same invariant on three). The screenshots are a side effect for
// eyeballing overlap; they land outside the repo, so the assertions are what
// actually fails.
const DIR = "/tmp/sub468-shots";

async function slot(page: import("@playwright/test").Page, name: string) {
  const chip = page.locator(".keyhints-chip");
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  await page.screenshot({ path: `${DIR}/${name}.png` });
  return box;
}

test("the keyboard button holds one coordinate across every desktop surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  const base = await slot(page, "01-note");

  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-head")).toBeVisible();
  expect(await slot(page, "02-today")).toEqual(base);

  await openDb(page, "Contact");
  expect(await slot(page, "03-database")).toEqual(base);

  // the split: an entry open beside the grid, close × next to the slot
  await page.locator(".db-table tbody tr", { hasText: "Gero" }).locator(".db-title").click();
  await expect(page.locator(".db-note .note-title")).toHaveValue("Gero");
  expect(await slot(page, "04-db-split")).toEqual(base);

  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  expect(await slot(page, "05-calendar")).toEqual(base);

  await page.locator(".side-item", { hasText: "Portfolio" }).click();
  // The head is the kicker-less title row now — wait on that
  await expect(page.locator(".dash-head").first()).toBeVisible();
  await expect(page.locator(".dash-kicker")).toHaveCount(0);
  expect(await slot(page, "06-dashboard")).toEqual(base);

  await page.keyboard.press("Meta+Shift+F");
  await expect(page.locator(".search-pane")).toBeVisible();
  await page.locator(".search-input").fill("the");
  await expect(page.locator(".search-note-row").first()).toBeVisible();
  expect(await slot(page, "07-search")).toEqual(base);

  // the doctor report's head carries a right-side action too, so it has to
  // reserve the slot like the rest.
  // Reload first: search left the caret in its own input, where ⌘K is inert.
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("vault doctor");
  await page.locator(".palette-item", { hasText: "Vault doctor" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Vault doctor");
  expect(await slot(page, "08-doctor")).toEqual(base);
  const copy = await page.locator(".list-head button").last().boundingBox();
  expect(copy.x + copy.width).toBeLessThanOrEqual(base.x);

  // and the panel itself, folded out over a note
  await page.keyboard.press("Escape");
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.locator(".keyhints-chip").click();
  await expect(page.locator(".keyhints-panel")).toBeVisible();
  // let the fold-out animation settle so the shot isn't a half-faded frame
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/09-panel-open.png` });
});

/* .note-feedback is the one sticky strip that shares the note's top band with
   the tools row, and it reserves the slot through its own margin-right rather
   than the --chrome-* terms — so it gets a real geometry assertion instead of
   the inference that the row's occupied width didn't change. */
test("the save-failure banner stops short of the chrome slot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_write_body"]);
  });
  await page.locator(".cm-content").focus();
  await page.keyboard.type("E2E-SLOT-BANNER");
  const banner = page.locator(".note-feedback");
  await expect(banner.locator(".save-error")).toBeVisible();

  const strip = await banner.boundingBox();
  const chip = await page.locator(".keyhints-chip").boundingBox();
  expect(strip.x + strip.width).toBeLessThanOrEqual(chip.x);
  await page.screenshot({ path: `${DIR}/10-feedback.png` });
  await page.evaluate(() => window.__mockFail.clear());
});
