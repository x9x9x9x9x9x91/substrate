import { expect, test, type Locator, type Page } from "./fixtures";
import { ALLDAY_CAP, overflowCount, todayBase } from "./calcells";

// Week is a time grid — a pinned all-day strip of entry
// cards (.cal-grid.week .cal-day[data-iso]) over a scrollable 24h canvas
// (.cal-wk-canvas) where timed entries render as blocks positioned by their
// HH:MM (.cal-wk-col[data-iso] .cal-wk-block). The entry DOM contract
// (.cal-entry, .cal-entry-title, .cal-entry-time) and the pane behaviors
// (open, entry menu, drag-to-reschedule, paging) hold on both halves.

/** "2026-07-18" — ISO of today +/- offsetDays, local like dates.todayIso */
function isoDay(offsetDays = 0): string {
  const d = todayBase();
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
  // lands on Scratch — Today is a destination)
  await expect(page.locator(".list-title")).toHaveText("Scratch");
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
  const dow = (todayBase().getDay() + 6) % 7; // Monday = 0
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

  // the mock vault dates enough entries onto today to overflow the strip:
  // all-day ones ride here capped at ALLDAY_CAP (+N more expands in place),
  // timed ones ride the canvas. How many all-day cards today carries moves
  // with the calendar, so N is read (see calcells.ts) and then held exactly —
  // expanding reveals precisely that many further cards.
  const cards = todayCell.locator(".cal-entry");
  await expect(cards).toHaveCount(ALLDAY_CAP);
  const overflow = await overflowCount(todayCell);
  await todayCell.locator('.cal-more[aria-expanded="false"]').click();
  await expect(cards).toHaveCount(ALLDAY_CAP + overflow);

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

  // …and the anchor hour's gutter label lands whole: the labels center on
  // their hour line, so a flush scroll would clip the first one in half
  const clip = await page.locator(".cal-wk-scroll").evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    let worst = 0;
    for (const s of el.querySelectorAll(".cal-wk-gutter span")) {
      const r = s.getBoundingClientRect();
      if (r.bottom > top && r.top < top + 40) worst = Math.max(worst, top - r.top);
    }
    return worst;
  });
  expect(clip).toBeLessThanOrEqual(0.5);
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
  // compose a probe entry so the drag never touches fixtures — on the week's
  // last day rather than today, because today is the loaded cell in the mock
  // vault and a capped strip may sort a fresh entry in behind "+N more"
  const dow = (todayBase().getDay() + 6) % 7; // Monday = 0
  const source = page.locator(`.cal-day[data-iso="${isoDay(6 - dow)}"]`);
  await source.locator(".cal-daynum").click();
  await page.locator(".cal-draft-input").fill("Week drag probe");
  await page.locator(".cal-draft-input").press("Enter");
  const card = source.locator(".cal-entry", { hasText: "Week drag probe" });
  await expect(card).toBeVisible();

  // a guaranteed-visible target ≠ the source: this week's Monday
  const target = page.locator(`.cal-day[data-iso="${isoDay(-dow)}"]`);

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
  const dow = (todayBase().getDay() + 6) % 7; // Monday = 0
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

/** How deep into the canvas column a pointer can actually be put, as a
    fraction of that column.

    The column is a full 24 h tall, but only the part of it that is inside the
    scrollport AND inside the window can take a drop — a release below that
    lands off the canvas and is deliberately a no-op. The all-day strip above
    the canvas owns a share of the pane, so that depth is a property of the
    running layout, not a constant: a strip that sizes itself to its cards
    moves it every time the fixture week changes. Specs that hard-coded a
    fraction of the column were really hard-coding one strip height. */
async function reachableFrac(page: Page, box: { y: number; height: number }) {
  const floor = await page.locator(".cal-wk-scroll").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return Math.min(r.bottom, window.innerHeight);
  });
  // a few px clear of the edge, so the release is unambiguously inside
  return (floor - 8 - box.y) / box.height;
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
  await block.locator(".cal-wk-grip:not(.top)").dragTo(col, {
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
  await block.locator(".cal-wk-grip:not(.top)").dragTo(col, {
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

test("drag a block's top edge sets the event's start, holding the end (SUB-1514)", async ({
  page,
}) => {
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  const col = page.locator(`.cal-wk-col[data-iso="${isoDay(0)}"]`);
  const box = (await col.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.1);
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("Start grip probe");
  await draft.press("Enter");
  const block = col.locator(".cal-wk-block", { hasText: "Start grip probe" });
  await expect(block).toBeVisible();
  const start = (await block.locator(".cal-entry-time").textContent())!;
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

  // the two drops below are placed against what the canvas can actually be
  // handed, not against a fixed slice of the column. The floor guards the
  // assertions themselves: with less than ~3 h of reachable canvas under the
  // probe's start, a real resize and a clamped no-op look alike, and a green
  // run would stop meaning anything. A red here is the all-day strip having
  // taken the canvas's working resolution — a design question about the
  // strip's height, not a spec to re-fit.
  const deepest = await reachableFrac(page, box);
  expect(deepest).toBeGreaterThan(0.1 + 3 / 24);
  const endAt = Math.min(0.3, deepest);
  const topAt = 0.1 + (endAt - 0.1) / 2; // halfway between the start and the end

  // give it a real end first, a few hours down the canvas
  await block.locator(".cal-wk-grip:not(.top)").dragTo(col, {
    targetPosition: { x: box.width / 2, y: box.height * endAt },
  });
  await expect.poll(() => heightFrac(block)).toBeGreaterThan(2 / 24);
  await block.click();
  await expect(endsField(page)).toHaveValue(/^\d{2}:(00|15|30|45)$/);
  const end = await endsField(page).inputValue();
  await closePeek(page);

  // pull the TOP edge down to halfway between the start and the end: the
  // start moves onto the drop's quarter-hour, the END stays where it was
  await block.locator(".cal-wk-grip.top").dragTo(col, {
    targetPosition: { x: box.width / 2, y: box.height * topAt },
  });
  await expect
    .poll(async () => min((await block.locator(".cal-entry-time").textContent())!))
    .toBeGreaterThan(min(start));
  const moved = (await block.locator(".cal-entry-time").textContent())!;
  expect(min(moved)).toBeLessThan(min(end));
  await block.click();
  await expect(endsField(page)).toHaveValue(end);
  await closePeek(page);

  // dropped ON its own end's minute — inside the 15-minute floor — the
  // start clamps to the last slot before the end: never flipping the event
  // around, never moving the end. (The drop returns to the end's own depth:
  // any deeper y sits below the reachable canvas and the release would land
  // off it, which is deliberately a no-op.)
  await block.locator(".cal-wk-grip.top").dragTo(col, {
    targetPosition: { x: box.width / 2, y: box.height * endAt },
  });
  await expect
    .poll(async () => min((await block.locator(".cal-entry-time").textContent())!))
    .toBe(min(end) - 15);
  await block.click();
  await expect(endsField(page)).toHaveValue(end);
});

test("the peek's end-day button pulls an over-dragged event back to its start day (SUB-1515)", async ({
  page,
}) => {
  await page.locator(".cal-wk-scroll").evaluate((el) => (el.scrollTop = 0));
  // the over-drag needs a NEXT column inside the same week — when today is
  // the week's last day, probe on yesterday instead
  const dow = new Date().getDay(); // 0 = Sunday, the rendered week's last column
  const base = dow === 0 ? isoDay(-1) : isoDay(0);
  const next = dow === 0 ? isoDay(0) : isoDay(1);
  const col = page.locator(`.cal-wk-col[data-iso="${base}"]`);
  const box = (await col.boundingBox())!;
  // compose early in the day — deeper y sits below the viewport
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.1);
  const draft = page.locator(".cal-wk-draft .cal-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("Overdrag probe");
  await draft.press("Enter");
  const block = col.locator(".cal-wk-block", { hasText: "Overdrag probe" });
  await expect(block).toBeVisible();
  const start = (await block.locator(".cal-entry-time").textContent())!;

  // drag the end past midnight: the continuation renders as an all-day chip
  // on the next day — the exact trap this issue documents
  await block
    .locator(".cal-wk-grip:not(.top)")
    .dragTo(page.locator(`.cal-wk-col[data-iso="${next}"]`), {
      targetPosition: { x: box.width / 2, y: box.height * 0.25 },
    });
  const chip = page.locator(
    `.cal-grid.week .cal-day[data-iso="${next}"] .cal-entry`,
    { hasText: "Overdrag probe" },
  );
  await expect(chip).toHaveCount(1);

  // the chip's peek says what it is: the Time row carries the STORED start,
  // never an empty field implying an all-day event. The Ends value settles a
  // beat after the write — the toHaveValue retry rides that out.
  await chip.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(page.locator(".cal-peek-time")).toHaveValue(start);
  await expect(endsField(page)).toHaveValue(/^\d{2}:(00|15|30|45)$/);
  const endHour = await endsField(page).inputValue();

  // the end's day beside the Ends field is a button — pick the start day
  // to pull the event home (typed, so the month grid's edges don't matter)
  await page.locator(".cal-peek-endday").click();
  await expect(page.locator(".datemenu")).toBeVisible();
  await page.locator(".datemenu .selmenu-input").fill(base);
  await page.locator(".datemenu .selmenu-input").press("Enter");
  await expect(chip).toHaveCount(0);

  // single-day again on its own start, the closing hour riding home whole —
  // it sits after the start here, so nothing needed clamping
  await closePeek(page);
  await expect(block.locator(".cal-entry-time")).toHaveText(start);
  await block.click();
  await expect(page.locator(".cal-peek")).toBeVisible();
  await expect(page.locator(".cal-peek-endday")).toHaveCount(0);
  await expect(endsField(page)).toHaveValue(endHour);
});
