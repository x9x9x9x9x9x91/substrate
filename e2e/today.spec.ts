import { expect, test, type Page } from "@playwright/test";

// The rebuilt Today surface: a day-agenda decision surface — three
// quiet lanes (Scheduled, Due & overdue, Picked for today), the one verb Pick
// (writes the `today` date prop), and a leftovers row for stale picks. Entry
// points are back (sidebar, palette, ⌘1) but cold open stays on Notes.
// Same deterministic mock backend as smoke.spec.ts.

/** "Jul 18" this year, "Jul 18, 2026" otherwise — mirrors calendar.humanDay */
function humanDay(offsetDays = 0): string {
  const MONTHS_SHORT = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const base = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** the lane section carrying an eyebrow label */
function lane(page: Page, eyebrow: string) {
  return page.locator(".today-section", { has: page.locator(".today-eyebrow", { hasText: eyebrow }) });
}

function chip(page: Page, key: string) {
  return page.locator(".chip").filter({ has: page.locator(".chip-key", { hasText: key }) });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // cold open lands on Notes — its first paint is the liveness
  // barrier; Today is a destination, reached here by its shortcut
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".today-pane")).toHaveCount(0);
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();
});

test("the three lanes render from fixtures, leftovers on top", async ({ page }) => {
  // header: eyebrow + confident date, e.g. "Friday, July 18" — and the
  // journal action the old surface carried
  await expect(page.locator(".today-head .today-eyebrow")).toHaveText("Today");
  await expect(page.locator(".today-date")).toHaveText(/^[A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}$/);
  await expect(page.locator(".today-journal")).toBeVisible();

  // the stale pick: yesterday's date shown, keep/clear at hand, never
  // silently carried into the Picked lane
  const leftovers = lane(page, "Leftovers");
  const stale = leftovers.locator(".today-row", { hasText: "Resequence the live set" });
  await expect(stale).toBeVisible();
  await expect(stale.locator(".today-row-day")).toHaveText(humanDay(-1));
  await expect(stale.locator(".today-act", { hasText: "Keep" })).toBeVisible();
  await expect(stale.locator(".today-act", { hasText: "Clear" })).toBeVisible();

  // Scheduled: today's events, all-day before the timed one — the
  // timed row closes the lane whatever fixed-date fixtures drift in
  const scheduled = lane(page, "Scheduled");
  await expect(scheduled.locator(".today-row", { hasText: "Umbra listening session" })).toBeVisible();
  await expect(scheduled.locator(".today-row", { hasText: "Mirror fauna vocal session" })).toBeVisible();
  const timed = scheduled.locator(".today-row", { hasText: "Label sync call" });
  await expect(timed.locator(".cal-entry-time")).toHaveText("14:00");
  const titles = await scheduled.locator(".today-row").allTextContents();
  expect(titles[titles.length - 1]).toContain("Label sync call");

  // Due & overdue: today's deadline tasks plus the slipped ones, overdue
  // first carrying the day they were due — the single red signal is the day
  // chip in --danger (no dot)
  const due = lane(page, "Due & overdue");
  const dueTodayRow = due.locator(".today-row", { hasText: "Approve SMP-030 artwork" });
  await expect(dueTodayRow).toBeVisible();
  const overdueRow = due.locator(".today-row", { hasText: "Renew Bandcamp plan" });
  await expect(overdueRow).toBeVisible();
  await expect(overdueRow.locator(".cal-dot")).toHaveCount(0);
  const overdueChip = overdueRow.locator(".today-row-day");
  await expect(overdueChip).toHaveText(humanDay(-2));
  await expect(overdueChip).toHaveClass(/overdue/);
  await expect(overdueChip).toHaveCSS("color", "rgb(235, 87, 87)");
  expect((await due.locator(".today-row").allTextContents())[0]).toContain(
    "Return the borrowed spring reverb"
  );

  // leftovers keep the quiet grey chip — no red vocabulary there
  await expect(stale.locator(".cal-dot")).toHaveCount(0);
  await expect(stale.locator(".today-row-day")).not.toHaveClass(/overdue/);

  // Picked: empty until the user decides — the quiet state, not a dashboard
  const picked = lane(page, "Picked for today");
  await expect(picked.locator(".today-quiet")).toHaveText("Nothing picked yet.");
  await expect(picked.locator(".today-row")).toHaveCount(0);
});

test("picking moves the row to Picked and writes the today prop", async ({ page }) => {
  const scheduled = lane(page, "Scheduled");
  const row = scheduled.locator(".today-row", { hasText: "Umbra listening session" });
  await row.locator(".today-act", { hasText: "Pick" }).click();

  // the row moved lanes — a pick is a commit, not a copy
  await expect(scheduled.locator(".today-row", { hasText: "Umbra listening session" })).toHaveCount(0);
  const picked = lane(page, "Picked for today");
  await expect(picked.locator(".today-row", { hasText: "Umbra listening session" })).toBeVisible();

  // the note carries the prop: open it from the lane, the chip is there
  await picked.locator(".today-row", { hasText: "Umbra listening session" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra listening session");
  await expect(chip(page, "today")).toHaveCount(1);
});

test("unpick clears the prop and sends the row back", async ({ page }) => {
  const due = lane(page, "Due & overdue");
  await due.locator(".today-row", { hasText: "Approve SMP-030 artwork" })
    .locator(".today-act", { hasText: "Pick" })
    .click();
  const picked = lane(page, "Picked for today");
  const row = picked.locator(".today-row", { hasText: "Approve SMP-030 artwork" });
  await expect(row).toBeVisible();

  await row.locator(".today-act", { hasText: "Unpick" }).click();
  await expect(picked.locator(".today-quiet")).toHaveText("Nothing picked yet.");
  await expect(due.locator(".today-row", { hasText: "Approve SMP-030 artwork" })).toBeVisible();

  // the prop is gone from the note
  await due.locator(".today-row", { hasText: "Approve SMP-030 artwork" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Approve SMP-030 artwork");
  await expect(chip(page, "today")).toHaveCount(0);
});

test("leftover Keep rolls the pick forward into Picked", async ({ page }) => {
  const stale = lane(page, "Leftovers").locator(".today-row", { hasText: "Resequence the live set" });
  await stale.locator(".today-act", { hasText: "Keep" }).click();

  await expect(lane(page, "Leftovers")).toHaveCount(0);
  await expect(
    lane(page, "Picked for today").locator(".today-row", { hasText: "Resequence the live set" })
  ).toBeVisible();
});

test("leftover Clear drops the stale pick", async ({ page }) => {
  const stale = lane(page, "Leftovers").locator(".today-row", { hasText: "Resequence the live set" });
  await stale.locator(".today-act", { hasText: "Clear" }).click();

  await expect(lane(page, "Leftovers")).toHaveCount(0);
  await expect(lane(page, "Picked for today").locator(".today-quiet")).toHaveText(
    "Nothing picked yet."
  );
  // the prop is gone — the note no longer carries any today chip
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Resequence");
  await page.locator(".palette-item", { hasText: "Resequence the live set" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Resequence the live set");
  await expect(chip(page, "today")).toHaveCount(0);
});

test("rows carry the note context menu; Move to Trash works from Today (SUB-378)", async ({ page }) => {
  const due = lane(page, "Due & overdue");
  const row = due.locator(".today-row", { hasText: "Renew Bandcamp plan" });
  await row.click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  // the full note menu, not a stub — spot-check the non-trivial items
  await expect(menu.locator(".ctx-item", { hasText: "Move to folder" })).toBeVisible();
  await menu.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(due.locator(".today-row", { hasText: "Renew Bandcamp plan" })).toHaveCount(0);
});

test("entry points: sidebar row and palette command reach the surface", async ({ page }) => {
  // already on Today via the beforeEach ⌘1 — the sidebar row is the active one
  const sideToday = page.locator(".side-item", { hasText: /^Today/ });
  await expect(sideToday).toHaveClass(/active/);
  await expect(sideToday).toContainText("⌘1");

  // away, then back by mouse
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await sideToday.click();
  await expect(page.locator(".today-pane")).toBeVisible();

  // away, then back by palette command
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("today");
  await page.locator(".palette-item", { hasText: "Go to Today" }).click();
  await expect(page.locator(".today-pane")).toBeVisible();
});
