import { expect, test } from "@playwright/test";

// A timed event going back to all-day. The peek's Time row clears to an
// all-day value, and an event that was drawn on the week canvas (stored as a
// start AND an end) has to leave the canvas for the all-day strip when it
// does — it used to keep its end and stay timed forever. Typing the field's
// own "All day" placeholder is the same request as emptying it.

/** "2026-07-18" — ISO of today, local like dates.todayIso */
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** the ranged mock event: `today 09:00/today 17:00`, the exact shape the
    canvas draws and the one the revert used to be impossible from */
const RANGED = "Cutting room workshop";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the list's first paint doubles as the "app is live" barrier
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();
});

for (const [name, typed] of [
  ["emptying the Time field", ""],
  ["typing “All day”", "All day"],
] as const) {
  test(`${name} moves a timed range off the canvas into the all-day strip`, async ({ page }) => {
    const iso = todayIso();
    const canvasBlock = page.locator(`.cal-wk-col[data-iso="${iso}"] .cal-wk-block`, {
      hasText: RANGED,
    });
    const stripCell = page.locator(`.cal-grid.week .cal-day[data-iso="${iso}"]`);
    await expect(canvasBlock).toHaveCount(1);

    await canvasBlock.click();
    const time = page.locator(".cal-peek .cal-peek-time");
    await expect(time).toHaveValue("09:00");
    await time.fill(typed);
    await time.press("Enter");

    // gone from the canvas, and the still-open peek agrees: no time, and so
    // no "Ends" row either — the end went with it
    await expect(canvasBlock).toHaveCount(0);
    await expect(time).toHaveValue("");
    await expect(page.locator(".cal-peek .cal-peek-end")).toHaveCount(0);
    // the Date row is the one that shows the whole stored value, and it is a
    // plain day: a surviving end time would read back here as a range even
    // though the block had already left the canvas
    await expect(page.locator(".cal-peek .cal-peek-val").first()).toHaveText(
      /^\w{3} \d{1,2}, \d{4}$/
    );

    // and it is in the all-day strip. Expanding the cell dismisses the peek
    // (an outside press), which is why it comes after the rows above; the
    // strip caps at 3 cards and today's fixtures overflow it.
    const more = stripCell.locator(".cal-more");
    if (await more.count()) await more.click();
    await expect(stripCell.locator(".cal-entry", { hasText: RANGED })).toHaveCount(1);
  });
}

test("a typo in the Time field changes nothing", async ({ page }) => {
  const iso = todayIso();
  const canvasBlock = page.locator(`.cal-wk-col[data-iso="${iso}"] .cal-wk-block`, {
    hasText: RANGED,
  });
  await canvasBlock.click();
  const time = page.locator(".cal-peek .cal-peek-time");
  await time.fill("half nine");
  await time.press("Enter");

  // the field puts the stored value back and the block stays where it was
  await expect(time).toHaveValue("09:00");
  await expect(canvasBlock).toHaveCount(1);
});

// Evidence run for the visual self-check — not a gate:
//   SHOTS=/tmp/shots npx playwright test e2e/calalldayrevert.spec.ts -g shot
test(`shot: ${RANGED} before and after the revert`, async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  const dir = process.env.SHOTS ?? "";
  const iso = todayIso();
  const canvasBlock = page.locator(`.cal-wk-col[data-iso="${iso}"] .cal-wk-block`, {
    hasText: RANGED,
  });
  await canvasBlock.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/1-timed-block.png` });
  await canvasBlock.click();
  await page.screenshot({ path: `${dir}/2-peek-open.png` });
  const time = page.locator(".cal-peek .cal-peek-time");
  await time.fill("All day");
  await page.screenshot({ path: `${dir}/3-typed-all-day.png` });
  await time.press("Enter");
  await expect(canvasBlock).toHaveCount(0);
  await page.screenshot({ path: `${dir}/4-reverted-to-strip.png` });
});

// The cross-day half of the same evidence run: a span that crosses days keeps
// its end DAY when the time goes, so it comes back as an all-day band rather
// than collapsing onto its first day. Staged through the mock backend's
// out-of-band prop seam — no fixture spans two days with times.
test("shot: a two-day timed span reverting to an all-day band", async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  const dir = process.env.SHOTS ?? "";
  const iso = todayIso();
  const next = new Date();
  next.setDate(next.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  const tomorrow = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;

  await page.evaluate(
    ([value]) =>
      (window as unknown as {
        __mockEditProp?: (path: string, key: string, v: unknown) => void;
      }).__mockEditProp?.("Calendar/Cutting room workshop.md", "date", value),
    [`${iso} 09:00/${tomorrow} 17:00`]
  );
  // re-enter the calendar so the pane reads the staged value
  await page.keyboard.press("Meta+2");
  await page.keyboard.press("Meta+4");
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();

  const block = page.locator(`.cal-wk-col[data-iso="${iso}"] .cal-wk-block`, { hasText: RANGED });
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/5-two-day-timed.png` });
  await block.click();
  const time = page.locator(".cal-peek .cal-peek-time");
  await time.fill("");
  await time.press("Enter");
  await expect(page.locator(".cal-peek .cal-peek-val").first()).toContainText("–");
  await page.screenshot({ path: `${dir}/6-two-day-all-day-band.png` });
});
