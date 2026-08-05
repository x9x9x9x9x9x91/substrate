import { expect, test } from "@playwright/test";

// The week canvas's columns are a real roving-tabindex widget. One
// column carries tabindex="0" (the focused day) and every other -1, so Tab
// enters the canvas exactly once; the focused column holds REAL DOM focus
// (document.activeElement), not a painted class; it names itself for a screen
// reader (role=group + aria-label from the day heading); and the arrow keys are
// handled on the element while the composer's input still owns its own keys.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();
});

test("exactly one column is a tab stop, and it names itself", async ({ page }) => {
  const cols = page.locator(".cal-wk-canvas .cal-wk-col");
  await expect(cols).toHaveCount(7);

  // a roving tabindex: one 0, six -1 — Tab enters the week once
  await expect(page.locator('.cal-wk-col[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.cal-wk-col[tabindex="-1"]')).toHaveCount(6);

  // and the tab stop carries an accessible name + a role that says what it is
  const rover = page.locator('.cal-wk-col[tabindex="0"]');
  await expect(rover).toHaveAttribute("role", "group");
  const label = await rover.getAttribute("aria-label");
  expect(label, "the column names itself from its day heading").toBeTruthy();
  // "Mon, Jul 20" — the weekday label over the column plus the day it holds
  expect(label!).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \w{3} \d{1,2}/);

  // every column is named, not just the rover — a screen reader reading across
  // the week never hits an anonymous group
  for (let i = 0; i < 7; i++)
    expect(await cols.nth(i).getAttribute("aria-label")).toBeTruthy();
});

test("keyboard focus lands on the focused day column for real", async ({ page }) => {
  // park focus on inert chrome, then use the calendar's own shortcut
  await page.locator(".cal-agenda-head").click();
  await page.keyboard.press("t");

  // real DOM focus, not a class: activeElement IS today's column
  const iso = isoDay(0);
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { cls: el?.className ?? "", iso: el?.getAttribute("data-iso") ?? "" };
  });
  expect(active.cls).toContain("cal-wk-col");
  expect(active.iso).toBe(iso);
  await expect(page.locator(`.cal-wk-col[data-iso="${iso}"]`)).toBeFocused();

  // the rover moved with it — the tab stop and real focus are the same column
  await expect(page.locator(`.cal-wk-col[data-iso="${iso}"]`)).toHaveAttribute("tabindex", "0");

  // →: focus rides along to the next day, and the rover follows it. (Not
  // asserted against today's column: on a Sunday, → pages into the next week
  // and today's column no longer exists — the invariant is "one tab stop, and
  // it is the focused element", which holds either way.)
  await page.keyboard.press("ArrowRight");
  const next = page.locator(`.cal-wk-col[data-iso="${isoDay(1)}"]`);
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("tabindex", "0");
  await expect(page.locator('.cal-wk-col[tabindex="0"]')).toHaveCount(1);
});

test("Tab reaches the week's column, and arrows walk the cursor from there", async ({ page }) => {
  const iso = isoDay(0);
  const col = page.locator(`.cal-wk-col[data-iso="${iso}"]`);

  // reach the column by focusing the tab stop the way Tab would
  await col.focus();
  await expect(col).toBeFocused();

  // arrows walk the time cursor with focus ON the column (the element-level
  // handler, not the window fallback)
  await page.keyboard.press("ArrowDown");
  const slot = col.locator(".cal-wk-slot");
  await expect(slot).toBeVisible();
  await expect(slot).toHaveAttribute("data-min", String(9 * 60));
  await page.keyboard.press("ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60 + 30));
  await page.keyboard.press("Shift+ArrowUp");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60 + 15));

  // the key ran exactly once per press — a double-handled ArrowDown would have
  // stepped a full hour instead of the half above
  await expect(page.locator(".cal-wk-slot")).toHaveCount(1);

  // focus never left the column while the cursor walked
  await expect(col).toBeFocused();
});

test("with the caret in the composer, arrows do not walk the cursor", async ({ page }) => {
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  await col.focus();

  // arm a cursor, then compose at it — the input takes focus
  await page.keyboard.press("ArrowDown");
  await expect(col.locator(".cal-wk-slot")).toHaveAttribute("data-min", String(9 * 60));
  await page.keyboard.press("Enter");
  const input = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(input).toBeFocused();

  // arrows now belong to the caret: the cursor holds at 09:00 and focus stays
  // in the input (isTyping guard, enforced on both key routes)
  await input.fill("caret probe");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(col.locator(".cal-wk-slot")).toHaveAttribute("data-min", String(9 * 60));
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("caret probe");

  // Escape dismisses the draft without composing
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);
});

test("a focused entry block keeps its own Enter (SUB-358 guard holds)", async ({ page }) => {
  // compose a timed entry, then focus its block: bare Enter must reach the
  // button, not the calendar's compose-at-slot shortcut
  const iso = isoDay(0);
  const col = page.locator(`.cal-wk-col[data-iso="${iso}"]`);
  await col.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const input = page.locator(".cal-wk-draft .cal-draft-input");
  await input.fill("Block focus probe");
  await input.press("Enter");

  const block = col.locator(".cal-wk-block", { hasText: "Block focus probe" });
  await expect(block).toBeVisible();

  // focus the block (a child of the column) — the column must not re-take the
  // day focus out from under it, and no draft opens on Enter
  await block.focus();
  await expect(block).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);
});
