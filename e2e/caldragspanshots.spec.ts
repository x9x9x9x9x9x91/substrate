import { expect, test, type Page } from "@playwright/test";

// Evidence run only: photographs a timed event being pulled into a multi-day
// span and back, to show that the span keeps its duration grip and stays
// draggable in the grid.
//   SHOTS=1 npx playwright test e2e/caldragspanshots.spec.ts
// One ground: the app has no runtime light theme (the only light surface is
// the print pass), so every shot is the one theme there is.
test.skip(!process.env.SHOTS, "evidence run only");

const OUT = process.env.SHOT_DIR || "/tmp/cal-drag-shots";
/** the mock vault's ranged event — `today 09:00/today 17:00`, drawn on the
    week canvas, which is where the duration grip lives */
const RANGED = "Cutting room workshop";

/** ISO of today and its neighbours, local like dates.todayIso */
function dayIso(offset = 0): string {
  const d = new Date();
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

/** the canvas scrolls to the current hour on open; the fixture sits at 09:00,
    so every shot rewinds it to the top to keep the block in frame */
async function showMorning(page: Page) {
  await page.locator(".cal-wk-scroll").evaluate((el) => {
    // the fixture starts at 09:00 — park the hour before it at the top
    el.scrollTop = (el.scrollHeight * 8) / 24;
  });
}

const block = (page: Page, iso: string) =>
  page.locator(`.cal-wk-col[data-iso="${iso}"] .cal-wk-block`, { hasText: RANGED });
const strip = (page: Page, iso: string) =>
  page.locator(`.cal-grid.week .cal-day[data-iso="${iso}"] .cal-entry`, {
    hasText: RANGED,
  });

test("shot: single day, span, and back", async ({ page }) => {
  await week(page);
  const start = dayIso(0);
  const later = dayIso(1);

  // 1 — the event as it starts: one day, one block, one grip
  await expect(block(page, start)).toHaveCount(1);
  await expect(block(page, start).locator(".cal-wk-grip")).toHaveCount(1);
  await showMorning(page);
  // the grip's bar only paints under the pointer — hover the block so the
  // shot shows what a hand on the event sees
  await block(page, start).hover();
  await page.screenshot({ path: `${OUT}/1-single-day.png` });

  // 2 — pull the grip onto the next day's canvas (the one surface a duration
  // drop aims at): a span, and the grip is still there
  await block(page, start)
    .locator(".cal-wk-grip")
    .dragTo(page.locator(`.cal-wk-col[data-iso="${later}"]`));
  await expect(strip(page, later)).toHaveCount(1);
  await expect(block(page, start).locator(".cal-wk-grip")).toHaveCount(1);
  await showMorning(page);
  await block(page, start).hover();
  await page.screenshot({ path: `${OUT}/2-span-keeps-grip.png` });

  // 3 — the span's continuation day is a drag source of its own
  await expect(strip(page, later)).toHaveAttribute("draggable", "true");
  await showMorning(page);
  await page.screenshot({ path: `${OUT}/3-tail-draggable.png` });

  // 4 — pull the grip back onto the start day: single-day again
  await block(page, start)
    .locator(".cal-wk-grip")
    .dragTo(page.locator(`.cal-wk-col[data-iso="${start}"]`));
  await expect(strip(page, later)).toHaveCount(0);
  await expect(block(page, start)).toHaveCount(1);
  await showMorning(page);
  await block(page, start).hover();
  await page.screenshot({ path: `${OUT}/4-back-to-single.png` });
});

test("shot: moving a span by its continuation day and back", async ({ page }) => {
  await week(page);
  const start = dayIso(0);
  const later = dayIso(1);
  const further = dayIso(2);

  // make it a span again, then grab the day it does NOT start on
  await block(page, start)
    .locator(".cal-wk-grip")
    .dragTo(page.locator(`.cal-wk-col[data-iso="${later}"]`));
  await expect(strip(page, later)).toHaveCount(1);

  // Dragging the tail one day on slides the whole range one day on. The
  // surface it lands on is the all-day strip, and the strip means all-day
  // wherever the hand took hold — so the range loses its start time and both
  // its days now draw as strip chips, the head included.
  await strip(page, later).dragTo(
    page.locator(`.cal-grid.week .cal-day[data-iso="${further}"]`)
  );
  await expect(strip(page, further)).toHaveCount(1);
  await expect(strip(page, later)).toHaveCount(1);
  await expect(block(page, later)).toHaveCount(0);
  await showMorning(page);
  await page.screenshot({ path: `${OUT}/5-span-moved.png` });

  // and back the way it came — still all-day, one day earlier
  await strip(page, further).dragTo(
    page.locator(`.cal-grid.week .cal-day[data-iso="${later}"]`)
  );
  await expect(strip(page, later)).toHaveCount(1);
  await expect(strip(page, start)).toHaveCount(1);
  await showMorning(page);
  await page.screenshot({ path: `${OUT}/6-span-moved-back.png` });
});

test("shot: the time ghost, and the slide that has no minute to show", async ({
  page,
}) => {
  await week(page);
  const start = dayIso(0);
  const later = dayIso(1);
  const target = dayIso(-1);
  // the canvas itself, so the pair of shots is about the drop affordance and
  // not about the week around it
  const grid = page.locator(".cal-wk-scroll");
  const ghost = page.locator(".cal-wk-ghost");

  // a drag has to be held open to photograph what it paints, so these
  // gestures are driven by hand rather than by dragTo
  const hold = async (from: ReturnType<typeof strip>, iso: string) => {
    await from.hover();
    await page.mouse.down();
    const box = (await page.locator(`.cal-wk-col[data-iso="${iso}"]`).boundingBox())!;
    // two moves: the first begins the drag, the second is the hover the drop
    // affordance answers
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.55);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.55 + 2);
  };

  // 7 — a span grabbed by its continuation day slides whole days: the drop
  // keeps the range's own times, so no minute is offered — but the column it
  // would land on still reads as the target
  await block(page, start)
    .locator(".cal-wk-grip")
    .dragTo(page.locator(`.cal-wk-col[data-iso="${later}"]`));
  await expect(strip(page, later)).toHaveCount(1);
  await showMorning(page);
  await hold(strip(page, later), target);
  await expect(ghost).toHaveCount(0);
  await expect(page.locator(`.cal-wk-col[data-iso="${target}"]`)).toHaveClass(/drop/);
  await grid.screenshot({ path: `${OUT}/7-slide-no-ghost.png` });
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // 8 — the move drag, for contrast: it names the minute it would land on
  await showMorning(page);
  await hold(block(page, start), target);
  await expect(ghost).toHaveCount(1);
  await grid.screenshot({ path: `${OUT}/8-move-ghost.png` });
  await page.mouse.up();
});
