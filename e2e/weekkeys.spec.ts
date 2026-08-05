import { expect, test } from "@playwright/test";

// The week canvas gets a keyboard path. ↑/↓ walk a half-hour time
// cursor (Shift = quarter-hours) down the focused day's column, rendered as
// .cal-wk-slot; Enter composes a timed draft at that slot — the keyboard twin
// of the canvas double-click; Escape clears the cursor before the day focus.
// Focusing a day now also scrolls and rings its canvas column, not just its
// all-day strip cell.

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
  // park keyboard focus on inert chrome so the pane's window listener owns
  // the keys (a focused control keeps its own Enter/Space)
  await page.locator(".cal-agenda-head").click();
});

test("arrow keys walk a half-hour time cursor down the focused day's canvas", async ({ page }) => {
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const slot = col.locator(".cal-wk-slot");

  // no cursor until ↑/↓ arms it
  await expect(page.locator(".cal-wk-slot")).toHaveCount(0);

  // t focuses today, then ↓ seeds the cursor at the working day's start
  await page.keyboard.press("t");
  await page.keyboard.press("ArrowDown");
  await expect(slot).toBeVisible();
  await expect(slot).toHaveAttribute("data-min", String(9 * 60));
  await expect(slot).toHaveText("09:00");

  // ↓ steps a half hour, ↑ steps back
  await page.keyboard.press("ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60 + 30));
  await page.keyboard.press("ArrowUp");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60));

  // Shift refines to quarter-hours
  await page.keyboard.press("Shift+ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60 + 15));
  await expect(slot).toHaveText("09:15");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60));

  // the band sits where its minute says: 09:00 = 9/24 down the column
  const top = await slot.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const c = el.parentElement!.getBoundingClientRect();
    return (b.top - c.top) / c.height;
  });
  expect(top).toBeCloseTo(9 / 24, 2);

  // left/right keep moving day focus — and take the cursor to the new day
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"] .cal-wk-slot`)).toHaveCount(0);
  await expect(page.locator(".cal-wk-slot")).toHaveCount(1);
});

test("Enter composes a timed draft at the cursor's slot; Escape clears the cursor", async ({
  page,
}) => {
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  await page.keyboard.press("t");
  await page.keyboard.press("ArrowDown"); // 09:00
  await page.keyboard.press("ArrowDown"); // 09:30
  await expect(col.locator(".cal-wk-slot")).toHaveAttribute("data-min", String(9 * 60 + 30));

  // Enter opens the composer on the canvas at that slot — not in the strip
  await page.keyboard.press("Enter");
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeFocused();
  await expect(page.locator(".cal-grid.week .cal-draft")).toHaveCount(0);
  await draft.fill("Keyboard slot probe");
  await draft.press("Enter");

  const block = col.locator(".cal-wk-block", { hasText: "Keyboard slot probe" });
  await expect(block).toBeVisible();
  await expect(block.locator(".cal-entry-time")).toHaveText("09:30");

  // Escape unwinds the cursor first, the day focus second
  await page.locator(".cal-agenda-head").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cal-wk-slot")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-wk-slot")).toHaveCount(0);
  await expect(page.locator(".cal-day.focused")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-day.focused")).toHaveCount(0);
});

test("focusing a day rings and scrolls its canvas column, not just its strip cell", async ({
  page,
}) => {
  const iso = isoDay(0);
  await page.keyboard.press("t");
  // both halves of the focused day carry the focus treatment
  await expect(page.locator(`.cal-grid.week .cal-day[data-iso="${iso}"]`)).toHaveClass(/focused/);
  await expect(page.locator(`.cal-wk-col[data-iso="${iso}"]`)).toHaveClass(/focused/);

  // the cursor pulls the canvas to itself: pin the scroll at 00:00, then walk
  // the cursor into the evening and the canvas follows
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  await page.keyboard.press("ArrowDown"); // 09:00
  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowDown"); // → 17:00
  await expect(page.locator(".cal-wk-slot")).toHaveAttribute("data-min", String(17 * 60));
  const scrollTop = await page.locator(".cal-wk-scroll").evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
});

test("walking to the floor of the day keeps the cursor on the half-hour grid", async ({ page }) => {
  // Review F1: the clamp used to pin at DAY_MIN - SLOT_FINE (23:45)
  // whatever the active step was, so a plain ↓ run to the bottom knocked the
  // cursor onto a :15/:45 phase it could never leave — and that phase went
  // straight into the composed note's time.
  const slot = page.locator(".cal-wk-slot");
  await page.keyboard.press("t");
  await page.keyboard.press("ArrowDown"); // seed at 09:00
  // walk past the floor: 30 presses covers 09:00 → 24:00 with room to spare
  for (let i = 0; i < 32; i++) await page.keyboard.press("ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(23 * 60 + 30));

  // and back up stays on :00/:30 rather than inheriting a quarter-hour phase
  await page.keyboard.press("ArrowUp");
  await expect(slot).toHaveAttribute("data-min", String(23 * 60));

  // a Shift step still reaches the true last quarter, and a plain ↓ from there
  // holds rather than dragging the cursor back up to 23:30
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(23 * 60 + 45));
  await page.keyboard.press("ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(23 * 60 + 45));
});

test("the time cursor rides along when the week pages", async ({ page }) => {
  // It was once claimed that the cursor clears when its day
  // leaves the week. It doesn't, and shouldn't — page() carries focusIso with
  // the view, so ⌘→ must not silently disarm a cursor the user just placed.
  const slot = page.locator(".cal-wk-slot");
  await page.keyboard.press("t");
  await page.keyboard.press("ArrowDown");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60));

  await page.keyboard.press("Meta+ArrowRight");
  await expect(slot).toHaveAttribute("data-min", String(9 * 60));
  await expect(page.locator(".cal-wk-col.focused")).toHaveCount(1);
});

test("the time cursor stays out of the month layout and the composer input", async ({ page }) => {
  // month: ↑/↓ keep paging weeks, no cursor anywhere
  await page.locator(".cal .db-switch button", { hasText: "Month" }).click();
  await expect(page.locator(".cal-grid.month")).toBeVisible();
  await page.locator(".cal-agenda-head").click();
  await page.keyboard.press("t");
  const before = await page.locator(".cal-day.focused").getAttribute("data-iso");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cal-wk-slot")).toHaveCount(0);
  await expect(page.locator(".cal-day.focused")).not.toHaveAttribute("data-iso", before!);

  // back on week: with the composer open, ↑/↓ belong to the input (isTyping)
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await page.locator(".cal-agenda-head").click();
  await page.keyboard.press("t");
  await page.keyboard.press("n");
  await expect(page.locator(".cal-draft-input")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cal-wk-slot")).toHaveCount(0);
  await expect(page.locator(".cal-draft-input")).toBeFocused();
});
