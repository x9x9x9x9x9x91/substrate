import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// email/phone property kinds: schema'd email/phone props render the
// value exactly as typed (no stripping — unlike url) as a link; clicking opens
// mailto:/tel: externally — window.open in the mock lane, stubbed here so the
// test stays offline; tel: strips spaces/dashes from the dialed number only.
// Right-click edits the raw string. Fixtures: the four contact rows all carry
// email values, Gero and Tess carry phones (src/lib/tauri.ts).

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
  await openDb(page, "Contact");
});

test("email/phone cells render as typed and open mailto:/tel: links (SUB-181)", async ({ page }) => {
  const emailCell = page.locator(".db-cell .url-link", { hasText: "gero@umbra.example" });
  await expect(emailCell).toHaveCount(1);
  await expect(page.locator(".db-cell .url-link", { hasText: "noa@umbra.example" })).toHaveCount(1);
  await expect(page.locator(".db-cell .url-link", { hasText: "booking@umbra.example" })).toHaveCount(1);
  await expect(page.locator(".db-cell .url-link", { hasText: "annelies@umbra.example" })).toHaveCount(1);
  const phoneCell = page.locator(".db-cell .url-link", { hasText: "+49 30 1234567" });
  await expect(phoneCell).toHaveCount(1);
  await expect(page.locator(".db-cell .url-link", { hasText: "+49 30 7654321" })).toHaveCount(1);

  await stubWindowOpen(page);
  await emailCell.click();
  await expect.poll(() => openedUrls(page)).toEqual(["mailto:gero@umbra.example"]);
  await phoneCell.click();
  await expect.poll(() => openedUrls(page)).toEqual(["mailto:gero@umbra.example", "tel:+49301234567"]);
});

test("email/phone note chips open externally; right-click edits the raw string (SUB-181)", async ({ page }) => {
  await page.locator(".db-title-txt", { hasText: "Gero" }).dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Gero");

  await expect(page.locator(".chip .url-link", { hasText: "gero@umbra.example" })).toHaveCount(1);
  await expect(page.locator(".chip .url-link", { hasText: "+49 30 1234567" })).toHaveCount(1);
  const emailLink = page.getByRole("link", { name: "Open email: gero@umbra.example" });
  const phoneLink = page.getByRole("link", { name: "Open phone: +49 30 1234567" });
  await expect(emailLink).toHaveAttribute("href", "mailto:gero@umbra.example");
  await expect(phoneLink).toHaveAttribute("href", "tel:+49301234567");

  await stubWindowOpen(page);
  await emailLink.click();
  await expect.poll(() => openedUrls(page)).toEqual(["mailto:gero@umbra.example"]);
  await phoneLink.click();
  await expect.poll(() => openedUrls(page)).toEqual(["mailto:gero@umbra.example", "tel:+49301234567"]);

  // editing lane: right-click opens the picker, current value shown raw
  await emailLink.click({ button: "right" });
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("gero@umbra.example");
});
