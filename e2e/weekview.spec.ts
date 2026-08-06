import { expect, test, type Locator, type Page } from "@playwright/test";

// Week is a time grid — a pinned all-day strip of entry
// cards (.cal-grid.week .cal-day[data-iso]) over a scrollable 24h canvas
// (.cal-wk-canvas) where timed entries render as blocks positioned by their
// HH:MM (.cal-wk-col[data-iso] .cal-wk-block). The entry DOM contract
// (.cal-entry, .cal-entry-title, .cal-entry-time) and the pane behaviors
// (open, entry menu, drag-to-reschedule, paging) hold on both halves.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO day + n days, local — week paging math */
function addDaysIso(iso: string, n: number): string {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the list's first paint doubles as the "app is live" barrier (cold open
  // lands on Notes — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal")).toBeVisible();
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  await expect(page.locator(".cal-grid.week")).toBeVisible();
});

test("week toggle renders the all-day strip over the 24h canvas", async ({ page }) => {
  const cells = page.locator(".cal-grid.week .cal-day");
  await expect(cells).toHaveCount(7);
  const cols = page.locator(".cal-wk-canvas .cal-wk-col");
  await expect(cols).toHaveCount(7);

  // the data-iso contract holds on both halves: a Monday-start run of
  // consecutive days, today inside
  const dow = (new Date().getDay() + 6) % 7; // Monday = 0
  for (let i = 0; i < 7; i++) {
    await expect(cells.nth(i)).toHaveAttribute("data-iso", isoDay(i - dow));
    await expect(cols.nth(i)).toHaveAttribute("data-iso", isoDay(i - dow));
  }

  // the today highlight lands on today's strip cell; the now-line on the
  // canvas column
  const todayCell = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  await expect(todayCell.locator(".cal-today")).toBeVisible();
  await expect(
    page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"] .cal-wk-now`)
  ).toHaveCount(1);

  // the mock vault dates 8 entries today, one timed — the strip carries the
  // 7 all-day cards capped at 3 (+4 more expands in place), the canvas the
  // timed block
  await expect(todayCell.locator(".cal-entry")).toHaveCount(3);
  await todayCell.locator(".cal-more").click();
  await expect(todayCell.locator(".cal-entry")).toHaveCount(7);

  // card anatomy: a title element plus a compact prop subtitle — a task reads
  // its status, an event without notable props falls back to its excerpt
  const task = todayCell.locator(".cal-entry", { hasText: "Ship the patron download codes" });
  await expect(task.locator(".cal-entry-title")).toHaveText("Ship the patron download codes");
  await expect(task.locator(".row-sub")).toContainText("todo");
  const event = todayCell.locator(".cal-entry", { hasText: "Umbra listening session" });
  await expect(event.locator(".row-sub")).toContainText("Full-album pass");
  await page.keyboard.press("Escape"); // collapse before the next assertions
});

test("timed entries render as canvas blocks positioned by their time", async ({ page }) => {
  const todayCol = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const block = todayCol.locator(".cal-wk-block", { hasText: "Label sync call" });
  await expect(block).toBeVisible();
  await expect(block.locator(".cal-entry-time")).toHaveText("14:00");

  // 14:00 → top: 14/24 of the day column, one default hour tall (1/24)
  const geom = await block.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const c = el.parentElement!.getBoundingClientRect();
    return { top: (b.top - c.top) / c.height, height: b.height / c.height };
  });
  expect(geom.top).toBeCloseTo(14 / 24, 2);
  expect(geom.height).toBeCloseTo(1 / 24, 2);

  // a timed entry lives on the canvas only — never doubles as a strip card
  await expect(
    page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, { hasText: "Label sync call" })
  ).toHaveCount(0);

  // the canvas opens scrolled to the week's action, not pinned at 00:00
  const scrollTop = await page.locator(".cal-wk-scroll").evaluate((el) => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
});

test("week cards peek on click, open their note on double-click, keep the entry menu", async ({
  page,
}) => {
  const todayCol = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  // a single click opens the peek popover, not the note
  await todayCol.locator(".cal-entry", { hasText: "Umbra listening session" }).click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(page.locator(".note-title")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-peek")).toHaveCount(0);

  // double-click is the direct-open power path
  await todayCol.locator(".cal-entry", { hasText: "Umbra listening session" }).dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");

  // back on the week surface, right-click keeps the Repeat… menu
  await page.keyboard.press("Meta+4");
  await page.locator(".cal .db-switch button", { hasText: "Week" }).click();
  const card = page.locator(`.cal-day[data-iso="${isoDay(0)}"] .cal-entry`, {
    hasText: "Umbra listening session",
  });
  await card.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Open" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Repeat…" })).toBeVisible();
});

test("drag a strip card to another day reschedules it", async ({ page }) => {
  // compose a probe entry on today so the drag never touches fixtures
  await page.locator(".cal .db-new", { hasText: "New" }).click();
  await page.locator(".cal-draft-input").fill("Week drag probe");
  await page.locator(".cal-draft-input").press("Enter");
  const source = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  const card = source.locator(".cal-entry", { hasText: "Week drag probe" });
  await expect(card).toBeVisible();

  // a guaranteed-visible target ≠ today: this week's Monday — or Tuesday when
  // today IS Monday
  const dow = (new Date().getDay() + 6) % 7; // Monday = 0
  const target = page.locator(`.cal-day[data-iso="${isoDay(dow === 0 ? 1 : -dow)}"]`);

  await card.dragTo(target);
  await expect(target.locator(".cal-entry", { hasText: "Week drag probe" })).toBeVisible();
  await expect(source.locator(".cal-entry", { hasText: "Week drag probe" })).toHaveCount(0);
});

test("drag a strip card onto the canvas gives it that slot's time", async ({ page }) => {
  await page.locator(".cal .db-new", { hasText: "New" }).click();
  await page.locator(".cal-draft-input").fill("Canvas drop probe");
  await page.locator(".cal-draft-input").press("Enter");
  const strip = page.locator(`.cal-day[data-iso="${isoDay(0)}"]`);
  const card = strip.locator(".cal-entry", { hasText: "Canvas drop probe" });
  await expect(card).toBeVisible();

  // drop onto today's canvas column at mid-height — the entry becomes timed
  // (snapped to a quarter hour) and leaves the all-day strip
  const target = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  await card.dragTo(target);
  const block = target.locator(".cal-wk-block", { hasText: "Canvas drop probe" });
  await expect(block).toBeVisible();
  await expect(block.locator(".cal-entry-time")).toHaveText(/^\d{2}:(00|15|30|45)$/);
  await expect(strip.locator(".cal-entry", { hasText: "Canvas drop probe" })).toHaveCount(0);

  // and back: dropping the block on the strip clears its time again
  await block.dragTo(strip);
  await expect(strip.locator(".cal-entry", { hasText: "Canvas drop probe" })).toBeVisible();
  await expect(target.locator(".cal-wk-block", { hasText: "Canvas drop probe" })).toHaveCount(0);
});

test("double-click on empty canvas composes a timed draft at that slot", async ({ page }) => {
  // the canvas opens scrolled to the afternoon — pin it to 00:00 first so
  // the 25%-height point (≈ 06:00) is actually inside the visible viewport
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  // dblclick today's column at 25% height ≈ 06:00 — the draft floats on the
  // canvas (not in the strip) and the created entry carries the slot's time
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const box = (await col.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.25);
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeVisible();
  await expect(page.locator(".cal-grid.week .cal-draft")).toHaveCount(0);
  await draft.fill("Slot compose probe");
  await draft.press("Enter");
  const block = col.locator(".cal-wk-block", { hasText: "Slot compose probe" });
  await expect(block).toBeVisible();
  await expect(block.locator(".cal-entry-time")).toHaveText(/^0(5|6):(00|15|30|45)$/);

  // a single click never composes — it only sets focus/opens nothing
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5);
  await expect(page.locator(".cal-draft-input")).toHaveCount(0);
});

test("canvas blocks peek on click and keep the entry menu", async ({ page }) => {
  const block = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"] .cal-wk-block`, {
    hasText: "Label sync call",
  });
  await block.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cal-peek")).toHaveCount(0);

  await block.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Open" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Repeat…" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("header, strip and canvas columns stay aligned", async ({ page }) => {
  // the three surfaces share a 46px + 7-col grid template — a future
  // scrollbar/padding change is exactly what this pins down
  const dow = (new Date().getDay() + 6) % 7; // Monday = 0
  const iso = isoDay(-dow); // Monday's column exists on all three
  const stripLeft = (await page
    .locator(`.cal-grid.week .cal-day[data-iso="${iso}"]`)
    .boundingBox())!.x;
  const canvasLeft = (await page
    .locator(`.cal-wk-col[data-iso="${iso}"]`)
    .boundingBox())!.x;
  expect(Math.abs(stripLeft - canvasLeft)).toBeLessThanOrEqual(1.5);
});

test("week paging steps seven days (buttons and ⌘←/→)", async ({ page }) => {
  const firstCol = page.locator(".cal-grid.week .cal-day").first();
  const startIso = await firstCol.getAttribute("data-iso");
  expect(startIso).toBeTruthy();

  await page.locator(".cal-pager button[title^='Next week']").click();
  await expect(firstCol).toHaveAttribute("data-iso", addDaysIso(startIso!, 7));

  await page.keyboard.press("Meta+ArrowLeft");
  await expect(firstCol).toHaveAttribute("data-iso", startIso!);

  await page.keyboard.press("Meta+ArrowRight");
  await expect(firstCol).toHaveAttribute("data-iso", addDaysIso(startIso!, 7));
});

/** the block's height as a fraction of its day column — 1/24 is one hour */
async function heightFrac(block: Locator): Promise<number> {
  return block.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const c = el.parentElement!.getBoundingClientRect();
    return b.height / c.height;
  });
}

/** the peek's "Ends" field — the typed twin of the bottom-edge drag */
function endsField(page: Page) {
  return page.locator(".cal-peek-end");
}

/** Esc out of the peek: the first press inside a field only reverts and
    blurs it, so keep pressing until the popover is actually gone */
async function closePeek(page: Page) {
  for (let i = 0; i < 3 && (await page.locator(".cal-peek").count()) > 0; i++) {
    await page.keyboard.press("Escape");
  }
  await expect(page.locator(".cal-peek")).toHaveCount(0);
}

test("drag a block's bottom edge sets the event's end (SUB-1171)", async ({ page }) => {
  // the canvas opens scrolled to the afternoon — pin it to 00:00 so a
  // percentage of the column height is a real on-screen point
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const box = (await col.boundingBox())!;

  // compose a timed probe early in the day so the block AND the slot it gets
  // dragged to both sit inside the viewport (never touches fixtures)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.1);
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("Resize probe");
  await draft.press("Enter");
  const block = col.locator(".cal-wk-block", { hasText: "Resize probe" });
  await expect(block).toBeVisible();
  const start = (await block.locator(".cal-entry-time").textContent())!;
  expect(start).toMatch(/^0[12]:(00|15|30|45)$/);
  // no end yet → the default one-hour block
  expect(await heightFrac(block)).toBeCloseTo(1 / 24, 2);

  // drag the grip down to ~20% of the day (≈ 04:45): the block grows, the
  // START stays exactly where it was
  await block.locator(".cal-wk-grip").dragTo(col, {
    targetPosition: { x: box.width / 2, y: box.height * 0.2 },
  });
  await expect.poll(() => heightFrac(block)).toBeGreaterThan(2 / 24);
  await expect(block.locator(".cal-entry-time")).toHaveText(start);

  // the end persisted onto the note's value — the peek reads it back, on the
  // move-drag's quarter-hour grid and strictly after the start
  await block.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(endsField(page)).toHaveValue(/^\d{2}:(00|15|30|45)$/);
  const dragged = await endsField(page).inputValue();
  expect(dragged > start).toBe(true);
  await closePeek(page);

  // dragged UP past its own start, the end clamps to the first slot after it
  // — never flipping the event around
  await block.locator(".cal-wk-grip").dragTo(col, {
    targetPosition: { x: box.width / 2, y: box.height * 0.05 },
  });
  await expect.poll(() => heightFrac(block)).toBeLessThan(1 / 24);
  await expect(block.locator(".cal-entry-time")).toHaveText(start);
  await block.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(endsField(page)).toHaveValue(/^\d{2}:(00|15|30|45)$/);
  const clamped = await endsField(page).inputValue();
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  expect(min(clamped) - min(start)).toBe(15);
});

test("the peek's Ends field writes the duration, clamping a reversed pair (SUB-1171)", async ({
  page,
}) => {
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const box = (await col.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.25);
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("Ends field probe");
  await draft.press("Enter");
  const block = col.locator(".cal-wk-block", { hasText: "Ends field probe" });
  await expect(block).toBeVisible();
  const start = (await block.locator(".cal-entry-time").textContent())!;

  // a typed end three hours out: empty to begin with, then the block wears it
  await block.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(endsField(page)).toHaveValue("");
  const hh = String(Number(start.slice(0, 2)) + 3).padStart(2, "0");
  await endsField(page).fill(`${hh}:30`);
  await endsField(page).press("Enter");
  await closePeek(page);
  await expect.poll(() => heightFrac(block)).toBeGreaterThan(2.5 / 24);

  // an end BEFORE the start comes back as the first slot after it — the field
  // shows what was actually committed, in place, and the start never moved
  await block.click();
  await expect(endsField(page)).toHaveValue(`${hh}:30`);
  await endsField(page).fill("00:15");
  await endsField(page).press("Enter");
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const clamped = await endsField(page).inputValue();
  expect(min(clamped) - min(start)).toBe(15);
  await expect(block.locator(".cal-entry-time")).toHaveText(start);
  // and it survives a reopen — the clamp was stored, not just displayed
  await closePeek(page);
  await block.click();
  await expect(endsField(page)).toHaveValue(clamped);

  // emptying the field drops the end entirely — back to the default hour
  await endsField(page).fill("");
  await endsField(page).press("Enter");
  await closePeek(page);
  await expect.poll(() => heightFrac(block)).toBeCloseTo(1 / 24, 2);
});
