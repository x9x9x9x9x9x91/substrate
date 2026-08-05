import { expect, test } from "@playwright/test";

// The shortcut-registry lanes against the same
// deterministic mock backend as smoke.spec.ts.

/** "Saturday, 18 July 2026" — the journal note's fixed header (journal.humanDate) */
function humanDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // first paint doubles as the "window key listeners attached" barrier (cold
  // open lands on Notes — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("⌃N/⌃P in search move the list selection and fire nothing else (SUB-110)", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+F");
  await expect(page.locator(".search-pane")).toBeVisible();
  await page.locator(".search-input").fill("the");
  await expect(page.locator(".search-note-row").nth(1)).toBeVisible();

  const selected = page.locator(".search-results .selected");
  await expect(selected).toHaveAttribute("data-idx", "0");
  await page.keyboard.press("Control+n");
  await expect(selected).toHaveAttribute("data-idx", "1");
  await page.keyboard.press("Control+p");
  await expect(selected).toHaveAttribute("data-idx", "0");
  // no capture, no palette — the pane is still the only thing up
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".search-input")).toHaveValue("the");
});

test("Esc from search restores the previously open note (SUB-111)", async ({ page }) => {
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page.locator(".list .row", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");

  await page.keyboard.press("Meta+Shift+F");
  await expect(page.locator(".search-pane")).toBeVisible();
  await page.locator(".search-input").fill("the");
  await expect(page.locator(".search-note-row").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator(".search-pane")).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
});

test("⌘⇧→ mid-edit keeps the day; outside text it steps (SUB-112)", async ({ page }) => {
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".note-title-daily")).toHaveText(humanDay());

  // editor focused: the chord extends the selection, the day stays put
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect(page.locator(".cm-editor.cm-focused")).toBeVisible();
  await expect(page.locator(".note-title-daily")).toHaveText(humanDay());

  // focus outside any text edit: the same chord steps the day
  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expect(page.locator(".note-title-daily")).toHaveText(humanDay(1));
});

test("sidebar Search row opens the search view, hint ⌘⇧F (SUB-134)", async ({ page }) => {
  const row = page.locator(".side-item", { hasText: /^Search/ });
  await expect(row.locator(".side-count")).toHaveText("⌘⇧F");
  await row.click();
  await expect(page.locator(".search-pane")).toBeVisible();
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".side-item.active", { hasText: /^Search/ })).toBeVisible();
});

test("cheat sheet: one row per label, both combos on the this-sheet row (SUB-139)", async ({ page }) => {
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-sheet")).toBeVisible();

  const labels = page.locator(".shortcut-row-label");
  await expect(labels.filter({ hasText: "Keyboard shortcuts (this sheet)" })).toHaveCount(1);
  const row = page.locator(".shortcut-row", { hasText: "Keyboard shortcuts (this sheet)" });
  expect(await row.locator(".key").allInnerTexts()).toEqual(["⌘/", "?"]);

  // the journal label stands alone — and "Go to Today" is back with the
  // rebuilt surface
  await expect(labels.filter({ hasText: "Open today's journal" })).toHaveCount(1);
  await expect(labels.filter({ hasText: "Go to Today" })).toHaveCount(1);
  // hasText is a substring test — exact-match the retired label instead
  await expect(
    page.locator(".shortcut-row-label", { hasText: /^Today's journal$/ })
  ).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.locator(".shortcut-sheet")).toHaveCount(0);
});

test("digit views: ⌘1 today, ⌘2 notes, ⌘3 all, ⌘4 calendar", async ({ page }) => {
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  // the scratch list rides along — untyped + unfiled only
  await expect(page.locator(".list .row")).toHaveCount(3);
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  // ⌘1 is back with the rebuilt Today surface
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();
  await expect(page.locator(".list")).toHaveCount(0);
});

test("app zoom: ⌘= steps up, ⌘− down, ⌘0 resets; the level survives reload (SUB-686)", async ({
  page,
}) => {
  // the mock/browser lane applies CSS zoom on <html>; 1 renders as ""
  const zoom = () => page.evaluate(() => document.documentElement.style.zoom || "1");
  expect(await zoom()).toBe("1");

  await page.keyboard.press("Meta+=");
  expect(await zoom()).toBe("1.1");
  await page.keyboard.press("Meta+=");
  expect(await zoom()).toBe("1.25");
  await expect(page.locator(".toast")).toContainText("Zoom 125%");

  // persisted per window: a reload comes back at the stepped level
  await page.reload();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  expect(await zoom()).toBe("1.25");

  await page.keyboard.press("Meta+-");
  expect(await zoom()).toBe("1.1");
  await page.keyboard.press("Meta+0");
  expect(await zoom()).toBe("1");

  // zooming is wanted mid-typing too — the combos are global scope
  await page.keyboard.press("Meta+2");
  await page.locator(".list .row").first().click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+=");
  expect(await zoom()).toBe("1.1");
  await page.keyboard.press("Meta+0");
});
