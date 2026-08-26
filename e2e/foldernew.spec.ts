import { expect, test } from "./fixtures";
import { openDb } from "./nav";
import { todayBase } from "./clock";

// The folder header carries a "+" that births a note in the open
// folder — the ⌘N fork made clickable (and reachable on touch): a
// database's home folder births that database's entries, any other folder a
// plain scratch note in place. Non-folder views stay plus-less; note creation
// there already has its own chrome (db-new, capture, ⌘N).

function chip(page: import("@playwright/test").Page, key: string) {
  return page.locator(".chip", { has: page.locator(".chip-key", { hasText: key }) });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("plain folder: + births a scratch note in that folder", async ({ page }) => {
  await page.locator(".side-folder", { hasText: "Projects" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Projects");
  const before = await page.locator(".list-body .row:not(.row-dbblock)").count();

  await page.locator(".list-new").click();
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  // born IN the folder — the open view gained a row (Inbox capture wouldn't)
  await expect(page.locator(".list-body .row:not(.row-dbblock)")).toHaveCount(before + 1);
});

test("database home folder: + births that database's entry", async ({ page }) => {
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await treeRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Show files" }).click();
  await expect(page.locator(".list-head .head-kind")).toHaveText("Folder");

  await page.locator(".list-new").click();
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await expect(chip(page, "Database").locator(".chip-val")).toHaveText("task");
});

test("Journal folder: + opens today's daily, no Untitled litter (SUB-593)", async ({ page }) => {
  // ⌘D lands in the Journal folder view with today's daily open
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".list-title")).toHaveText("Journal");
  const humanToday = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(todayBase());

  const plus = page.locator(".list-new");
  await expect(plus).toHaveAttribute("aria-label", "Open today’s entry");
  await plus.click();
  // today's daily, not a loose scratch note — the dated header, zero Untitled
  await expect(page.locator(".note-title-daily")).toHaveText(humanToday);
  await expect(page.locator(".list-body .row", { hasText: "Untitled" })).toHaveCount(0);
});

test("non-folder views carry no header plus", async ({ page }) => {
  await expect(page.locator(".list-new")).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-new")).toHaveCount(0);
  // a database header has its own "+ New" chrome — no second plus
  await openDb(page, "Release");
  await expect(page.locator(".list-new")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the plus is the touch create path, at a 44px target", async ({ page }) => {
    await page.locator(".mobile-menu").click();
    // The drawer is deliberately non-interactive while it moves;
    // wait on the user-facing readiness contract, not an arbitrary timeout.
    await expect(page.locator(".sidebar")).toHaveCSS("pointer-events", "auto");
    await page.locator(".sidebar .side-folder", { hasText: "Projects" }).first().click();
    await expect(page.locator(".list-title")).toHaveText("Projects");

    const plus = page.locator(".list-new");
    const box = await plus.boundingBox();
    expect(box && Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);

    await plus.click();
    await expect(page.locator(".note-title")).toHaveValue("Untitled");
  });
});
