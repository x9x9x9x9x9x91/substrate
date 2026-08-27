import { expect, test, type Locator } from "./fixtures";
import { todayBase } from "./clock";

// Day is not a third calendar surface — it is the Week canvas with
// one column. So this spec deliberately reuses Week's selectors (.cal-grid.week,
// .cal-wk-canvas, .cal-wk-col[data-iso], .cal-wk-block, .cal-wk-grip): if any
// of them stopped matching in Day, the "one column" promise would have been
// re-implemented instead of parameterized, which is the thing worth catching.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = todayBase();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO day + n days, local — day paging math */
function addDaysIso(iso: string, n: number): string {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** the block's height as a fraction of its day column — 1/24 is one hour */
async function heightFrac(block: Locator): Promise<number> {
  return block.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const c = el.parentElement!.getBoundingClientRect();
    return b.height / c.height;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Scratch");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal .cal-layouts button", { hasText: "Day" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();
});

test("the Day layout is the week canvas rendering one column", async ({ page }) => {
  // one strip cell, one canvas column, one weekday header — all on today
  await expect(page.locator(".cal-grid.week .cal-day")).toHaveCount(1);
  await expect(page.locator(".cal-wk-canvas .cal-wk-col")).toHaveCount(1);
  // (the header's first span is the hour gutter's spacer, not a weekday)
  await expect(page.locator(".cal-weekdays span:not(.cal-wk-spacer)")).toHaveCount(1);
  await expect(page.locator(".cal-grid.week .cal-day").first()).toHaveAttribute(
    "data-iso",
    isoDay(0)
  );
  await expect(page.locator(".cal-wk-canvas .cal-wk-col").first()).toHaveAttribute(
    "data-iso",
    isoDay(0)
  );
  // the header names the weekday the column actually carries
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  await expect(page.locator(".cal-weekdays span:not(.cal-wk-spacer)")).toHaveText(
    names[(todayBase().getDay() + 6) % 7]
  );

  // the canvas's own furniture survives at one column: hour gutter, now-line,
  // the fixture's timed block, and the strip/canvas alignment Week pins down
  await expect(page.locator(".cal-wk-gutter")).toHaveCount(1);
  await expect(page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"] .cal-wk-now`)).toHaveCount(1);
  await expect(
    page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"] .cal-wk-block`, {
      hasText: "Label sync call",
    })
  ).toBeVisible();
  const stripLeft = (await page.locator(`.cal-grid.week .cal-day[data-iso="${isoDay(0)}"]`).boundingBox())!.x;
  const canvasLeft = (await page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`).boundingBox())!.x;
  expect(Math.abs(stripLeft - canvasLeft)).toBeLessThanOrEqual(1.5);

  // and switching back to Week widens the same surface to seven columns
  await page.locator(".cal .cal-layouts button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-wk-canvas .cal-wk-col")).toHaveCount(7);
});

test("day paging steps one day, across a month boundary (buttons and ⌘←/→)", async ({ page }) => {
  const col = page.locator(".cal-grid.week .cal-day").first();
  const startIso = (await col.getAttribute("data-iso"))!;
  expect(startIso).toBeTruthy();

  await page.locator(".cal-pager button[title^='Next day']").click();
  await expect(col).toHaveAttribute("data-iso", addDaysIso(startIso, 1));

  await page.keyboard.press("Meta+ArrowLeft");
  await expect(col).toHaveAttribute("data-iso", startIso);

  // walk forward to the 1st of next month — every step is exactly one day, and
  // the month rolls over without any month-grid logic getting involved
  const today = todayBase();
  const firstNext = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const steps = Math.round((firstNext.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
  let iso = startIso;
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Meta+ArrowRight");
    iso = addDaysIso(iso, 1);
    await expect(col).toHaveAttribute("data-iso", iso);
  }
  expect(iso.slice(8, 10)).toBe("01");
  // the last step crossed the boundary from that month's final day
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(col).toHaveAttribute("data-iso", addDaysIso(iso, -1));
  expect(addDaysIso(iso, -1).slice(5, 7)).toBe(startIso.slice(5, 7));
});

test("an all-day entry drags onto the Day canvas and takes that slot's time", async ({ page }) => {
  // compose a probe so the drag never touches fixtures
  await page.locator(".cal .db-new", { hasText: "New" }).click();
  await page.locator(".cal-draft-input").fill("Day drag probe");
  await page.locator(".cal-draft-input").press("Enter");
  const strip = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  const card = strip.locator(".cal-entry", { hasText: "Day drag probe" });
  await expect(card).toBeVisible();

  // drop it on the canvas: it becomes timed on the quarter-hour grid and
  // leaves the all-day strip — the week behaviour, unchanged at one column
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  await card.dragTo(col);
  const block = col.locator(".cal-wk-block", { hasText: "Day drag probe" });
  await expect(block).toBeVisible();
  await expect(block.locator(".cal-entry-time")).toHaveText(/^\d{2}:(00|15|30|45)$/);
  await expect(strip.locator(".cal-entry", { hasText: "Day drag probe" })).toHaveCount(0);

  // and back: dropping the block on the strip clears its time again
  await block.dragTo(strip);
  await expect(strip.locator(".cal-entry", { hasText: "Day drag probe" })).toBeVisible();
  await expect(col.locator(".cal-wk-block", { hasText: "Day drag probe" })).toHaveCount(0);
});

test("a Day block resizes by its bottom-edge grip, exactly as in Week (SUB-1171)", async ({
  page,
}) => {
  // the canvas opens scrolled to the afternoon — pin it to 00:00 so a
  // percentage of the column height is a real on-screen point
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const box = (await col.boundingBox())!;

  // compose a timed probe early in the day so the block AND the slot its grip
  // gets dragged to both sit inside the viewport
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.1);
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("Day resize probe");
  await draft.press("Enter");
  const block = col.locator(".cal-wk-block", { hasText: "Day resize probe" });
  await expect(block).toBeVisible();
  const start = (await block.locator(".cal-entry-time").textContent())!;
  expect(await heightFrac(block)).toBeCloseTo(1 / 24, 2);

  // the grip grows the block and leaves the start exactly where it was
  await block.locator(".cal-wk-grip:not(.top)").dragTo(col, {
    targetPosition: { x: box.width / 2, y: box.height * 0.2 },
  });
  await expect.poll(() => heightFrac(block)).toBeGreaterThan(2 / 24);
  await expect(block.locator(".cal-entry-time")).toHaveText(start);

  // the peek opens on the block and reads the stored end back (its Ends row)
  await block.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(page.locator(".cal-peek-end")).toHaveValue(/^\d{2}:(00|15|30|45)$/);
});
