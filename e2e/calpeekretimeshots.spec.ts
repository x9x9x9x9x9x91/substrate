import { expect, test, type Page } from "./fixtures";
import { todayBase } from "./clock";

// Evidence run only: photographs the peek's Time row taking a time that lands
// PAST the block's own end. The write used to reverse the pair — the block
// came back starting at the old END and the field snapped back to a time
// nobody typed — so these shots are the before/after of the block's own
// position on the canvas.
//   SHOTS=1 npx playwright test e2e/calpeekretimeshots.spec.ts
// One ground: the app has no runtime light theme (the only light surface is
// the print pass), so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOT_DIR || "/tmp/cal-retime-shots";
/** the mock vault's ranged event — `today 09:00/today 17:00` on the week
    canvas, the only seeded block with an end to overtake */
const RANGED = "Cutting room workshop";

function dayIso(offset = 0): string {
  const d = todayBase();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function week(page: Page) {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();
}

/** the canvas scrolls to the current hour on open; every shot rewinds it so
    the whole working day is in frame */
async function showDay(page: Page) {
  await scrollToHour(page, 8);
}

/** the evening, for the one frame whose subject sits after 18:00 */
async function showEvening(page: Page) {
  await scrollToHour(page, 15);
}

async function scrollToHour(page: Page, hour: number) {
  await page.locator(".cal-wk-scroll").evaluate((el, h) => {
    el.scrollTop = (el.scrollHeight * h) / 24;
  }, hour);
}

const block = (page: Page, iso: string) =>
  page.locator(`.cal-wk-col[data-iso="${iso}"] .cal-wk-block`, { hasText: RANGED });

test("shot: a start time typed past the block's end", async ({ page }) => {
  await week(page);
  const today = dayIso(0);

  // 1 — the event as it starts: 09:00–17:00 on the canvas
  await expect(block(page, today)).toHaveCount(1);
  await showDay(page);
  await page.screenshot({ path: `${OUT}/1-before.png` });

  // shorten it to 09:00–10:30 first, so the retime below has room to land
  // later the same day rather than rolling the block over midnight
  await block(page, today).click();
  const peek = page.locator(".cal-peek");
  await expect(peek).toBeVisible();
  const ends = peek.locator(".cal-peek-end");
  // the Ends draft syncs a beat after the write behind it settles — read it
  // through a retrying expect rather than once
  await expect(ends).toHaveValue("17:00");
  await ends.fill("10:30");
  await ends.press("Enter");
  await expect(ends).toHaveValue("10:30");
  await showDay(page);
  await page.screenshot({ path: `${OUT}/2-short-block.png` });

  // 2 — type a start PAST that end. The typed time must stay the start and
  // the block keeps its 90 minutes: 18:00–19:30, same day.
  const time = peek.locator(".cal-peek-time");
  await expect(time).toHaveValue("09:00");
  await time.fill("18:00");
  await time.press("Enter");
  await expect(time).toHaveValue("18:00");
  await expect(ends).toHaveValue("19:30");
  await showDay(page);
  await page.screenshot({ path: `${OUT}/3-after-retime.png` });

  // and the block itself moved down the canvas rather than growing upward
  // from a start nobody typed — photographed with the peek dismissed
  // two presses, which is the peek's own design: the first Esc belongs to the
  // focused field (revert + hand focus back), only the second closes the peek
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await expect(block(page, today)).toHaveCount(1);
  // the evening, not the working day: the block is where it was typed, so a
  // frame of 08:00–15:00 would photograph an empty canvas and prove nothing
  await showEvening(page);
  await expect(block(page, today)).toBeInViewport();
  await page.screenshot({ path: `${OUT}/4-after-no-peek.png` });
});
