import { expect, test } from "@playwright/test";

// The Journal surface (SUB-176, SUB-210): ⌘D and the sidebar row open today's
// journal; day-stepping back opens past days as ghosts — no file until the
// first keystroke. Salvaged from today.spec.ts when the Today surface was
// hidden (SUB-299).

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
const humanToday = () => humanDay(0);

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // cold open lands on the Notes scratch list (SUB-299) — first paint doubles
  // as the "window key listeners attached" barrier
  await expect(page.locator(".list-title")).toHaveText("Notes");
});

test("⌘D and the sidebar Journal item open today's journal", async ({ page }) => {
  await page.keyboard.press("Meta+d");
  // ⌘D lands in the Journal folder view (SUB-176), not All notes
  await expect(page.locator(".list-title")).toHaveText("Journal");
  await expect(page.locator(".note-title-daily")).toHaveText(humanToday());

  // back on Notes, the sidebar's Journal row lands in the same place
  await page.keyboard.press("Meta+2");
  // (not the Journal folder the tree gained when the note was created)
  await page.locator(".side-item:not(.side-folder)", { hasText: /^Journal/ }).click();
  await expect(page.locator(".list-title")).toHaveText("Journal");
  await expect(page.locator(".note-title-daily")).toHaveText(humanToday());

  // day-stepping stays in the Journal list. Yesterday opens as a ghost
  // (SUB-210): the dated surface shows, but no file — and no row — exists
  // until something is typed
  await page.locator(".daily-nav[title='Yesterday (⌘⇧←)']").click();
  await expect(page.locator(".list-title")).toHaveText("Journal");
  await expect(page.locator(".note-title-daily")).toHaveText(humanDay(-1));
  const rows = page.locator(".list .row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-path", `Journal/${isoDay()}.md`);

  // the first keystroke makes yesterday real — its row appears under today's
  await page.locator(".cm-content").click();
  await page.keyboard.type("backfilled thought");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-path", `Journal/${isoDay(-1)}.md`);
  // the sidebar Journal row is active whenever the Journal view is open
  await expect(page.locator(".side-item:not(.side-folder)", { hasText: /^Journal/ })).toHaveClass(
    /active/
  );
});
