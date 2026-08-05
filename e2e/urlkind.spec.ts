import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// url property kind: a schema'd url prop renders the stripped
// display title (no scheme, no www., no trailing slash) as a link; clicking
// opens the raw URL externally — window.open in the mock lane, stubbed here
// so the test stays offline; editing shows the raw string. Fixtures: three
// inventory rows carry `link` values (src/lib/tauri.ts GEAR_LINKS).

async function stubWindowOpen(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[]; open: (u?: string) => null };
    w.__opened = [];
    w.open = (u?: string) => {
      w.__opened.push(String(u));
      return null;
    };
  });
}

function openedUrls(page: Page) {
  return page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
});

test("url cells render the stripped title and open the raw link (SUB-172)", async ({ page }) => {
  const cell = page.locator(".db-cell .url-link", { hasText: "aeon.audio/driftbox" });
  await expect(cell).toHaveCount(1);
  await expect(page.locator(".db-cell .url-link", { hasText: "tapeworks.shop/t-4" })).toHaveCount(1);
  await expect(page.locator(".db-cell .url-link", { hasText: "sirene.audio/s-2" })).toHaveCount(1);

  await stubWindowOpen(page);
  await cell.click();
  await expect.poll(() => openedUrls(page)).toEqual(["https://www.aeon.audio/driftbox"]);
});

test("url note chip opens externally; right-click edits the raw string (SUB-172)", async ({ page }) => {
  await page.locator(".db-title-txt", { hasText: "Aeon Driftbox" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Aeon Driftbox");

  await expect(page.locator(".chip .url-link")).toHaveText("aeon.audio/driftbox");
  const link = page.getByRole("link", { name: "Open link: aeon.audio/driftbox" });
  await expect(link).toHaveAttribute("href", "https://www.aeon.audio/driftbox");

  await stubWindowOpen(page);
  await link.click();
  await expect.poll(() => openedUrls(page)).toEqual(["https://www.aeon.audio/driftbox"]);

  // editing lane: right-click opens the picker, current value shown raw
  await link.click({ button: "right" });
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("https://www.aeon.audio/driftbox");
});
