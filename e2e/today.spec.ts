import { expect, test, type Page } from "./fixtures";
import { todayBase } from "./clock";

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
  const d = todayBase();
  d.setDate(d.getDate() + offsetDays);
  const base = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === todayBase().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
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

test("a dateless note reaches Today by palette, and the ⋯ menu takes it off (SUB-1162)", async ({
  page,
}) => {
  // "Capture anything" carries no date at all, so it never surfaces as a
  // candidate in any lane — before the verb left the pane it had no route
  // onto Today whatsoever
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Capture anything");
  await page.locator(".palette-item", { hasText: "Capture anything" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  // the palette has to be gone before the next ⌘K, or the chord toggles the
  // still-open one shut instead of reopening it
  await expect(page.locator(".palette-input")).toHaveCount(0);
  await expect(chip(page, "today")).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Pick for today");
  // the Commands row, not the "search for it" / "new note named it" rows
  await page.getByRole("option", { name: "Pick for today", exact: true }).click();
  await expect(chip(page, "today")).toHaveCount(1);
  // the palette has to finish tearing down before the next chord, or the
  // keypress lands on the node being removed and no shortcut ever sees it
  await expect(page.locator(".palette-input")).toHaveCount(0);

  await page.keyboard.press("Meta+1");
  const picked = lane(page, "Picked for today");
  await expect(picked.locator(".today-row", { hasText: "Capture anything" })).toBeVisible();

  // and off again from the open note's ⋯ menu — the same action, the label
  // flipped, on a surface that used to have no opinion about Today
  await picked.locator(".today-row", { hasText: "Capture anything" }).click();
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Unpick from today" }).click();
  await expect(chip(page, "today")).toHaveCount(0);

  await page.keyboard.press("Meta+1");
  await expect(lane(page, "Picked for today").locator(".today-quiet")).toHaveText(
    "Nothing picked yet."
  );
});

test("the pane's rows are one keyboard list across the lanes (SUB-1162)", async ({ page }) => {
  const list = page.locator(".today-rows");
  const rows = page.locator(".today-row");
  await list.focus();

  // j walks the flat list in the order the day reads — leftovers first
  await page.keyboard.press("j");
  await expect(rows.nth(0)).toHaveClass(/selected/);
  await expect(rows.nth(0)).toContainText("Resequence the live set");
  await expect(list).toHaveAttribute("aria-activedescendant", await rows.nth(0).getAttribute("id"));

  // the pane takes the bare letters only: ⌘K is still the palette even with
  // the list holding focus
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await list.focus();

  // and crosses the lane boundary without a second key model
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(rows.nth(0)).not.toHaveClass(/selected/);
  await page.keyboard.press("k");
  await expect(rows.nth(0)).toHaveClass(/selected/);

  // p is the one verb: on the stale pick it rolls forward, exactly as Keep does
  await page.keyboard.press("p");
  await expect(lane(page, "Leftovers")).toHaveCount(0);
  const picked = lane(page, "Picked for today");
  const pickedRow = picked.locator(".today-row", { hasText: "Resequence the live set" });
  await expect(pickedRow).toBeVisible();

  /* and the highlight goes with the note, not with the slot.
     No hover in between, deliberately: a pick moves its row across lanes at
     CONSTANT total length, so a selection clamped on the row count never
     notices and the highlight is left sitting on whatever shifted into the old
     index — here, the first Scheduled row. */
  await expect(pickedRow).toHaveClass(/selected/);
  await expect(page.locator(".today-row.selected")).toHaveCount(1);
  await expect(list).toHaveAttribute("aria-activedescendant", await pickedRow.getAttribute("id"));
  await expect(rows.nth(0)).not.toHaveClass(/selected/);

  // the mouse and the keyboard share the selection, and Backspace takes the
  // row off today — never out of the vault
  await pickedRow.hover();
  await expect(pickedRow).toHaveClass(/selected/);
  await page.keyboard.press("Backspace");
  await expect(picked.locator(".today-quiet")).toHaveText("Nothing picked yet.");
  // Backspace stayed the pane's key — it did not also walk the view history
  await expect(page.locator(".today-pane")).toBeVisible();

  // Enter opens the selected row's note, same route the click takes
  await list.focus();
  await page.keyboard.press("j");
  const title = await rows.nth(0).locator(".today-row-title").textContent();
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue(title ?? "");
});

test("⌫ only clears a row that carries a pick (SUB-1162)", async ({ page }) => {
  // a real pick first, so the undo stack has something to answer with
  const scheduled = lane(page, "Scheduled");
  await scheduled
    .locator(".today-row", { hasText: "Umbra listening session" })
    .locator(".today-act", { hasText: "Pick" })
    .click();
  const picked = lane(page, "Picked for today");
  await expect(picked.locator(".today-row", { hasText: "Umbra listening session" })).toBeVisible();

  // a candidate that has never been picked: there is no pick prop to clear
  const target = lane(page, "Due & overdue").locator(".today-row", {
    hasText: "Approve SMP-030 artwork",
  });
  await page.locator(".today-rows").focus();
  await target.hover();
  await expect(target).toHaveClass(/selected/);
  await page.keyboard.press("Backspace");

  // the row stays where it is, and the pane keeps the key rather than letting
  // bare ⌫ walk the view history out of Today
  await expect(target).toBeVisible();
  await expect(page.locator(".today-pane")).toBeVisible();

  // and nothing landed on the undo stack: ⌘Z answers with the pick, the last
  // real change. A null-over-null write would have burned the chord on an
  // edit that changed nothing.
  await page.keyboard.press("Meta+z");
  await expect(scheduled.locator(".today-row", { hasText: "Umbra listening session" })).toBeVisible();
  await expect(picked.locator(".today-row", { hasText: "Umbra listening session" })).toHaveCount(0);
});

test("Today rows offer Pick in the context menu (SUB-1162)", async ({ page }) => {
  const row = lane(page, "Due & overdue").locator(".today-row", { hasText: "Renew Bandcamp plan" });
  await row.click({ button: "right" });
  await page.locator(".ctx-menu .ctx-item", { hasText: "Pick for today" }).click();
  await expect(
    lane(page, "Picked for today").locator(".today-row", { hasText: "Renew Bandcamp plan" })
  ).toBeVisible();
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

test("the capture line creates a note already picked for today", async ({ page }) => {
  const picked = lane(page, "Picked for today");
  await expect(picked.locator(".today-quiet")).toHaveText("Nothing picked yet.");

  const line = page.locator(".today-add-input");
  await line.fill("Bounce the dub stems");
  await line.press("Enter");

  // the note exists and is already on the day — no second step, no
  // hunting for the note that did not exist a moment ago
  const row = picked.locator(".today-row", { hasText: "Bounce the dub stems" });
  await expect(row).toBeVisible();
  // the line empties itself for the next thought
  await expect(line).toHaveValue("");

  // it is an ordinary note carrying the ordinary pick prop
  await row.click();
  await expect(page.locator(".note-title")).toHaveValue("Bounce the dub stems");
  await expect(chip(page, "today")).toHaveCount(1);
});

test("the day wrap shows its line and clears the leftovers it names", async ({ page }) => {
  await page.locator(".today-wrap-act", { hasText: "Wrap the day" }).click();
  // the confirmation is the line itself, not a promise about it
  const line = page.locator(".today-wrap-line");
  await expect(line).toContainText("- Day wrap:");
  await expect(page.locator(".today-wrap")).toContainText("Resequence the live set");
  await page.locator(".today-wrap-act", { hasText: "Write and clear" }).click();
  await expect(lane(page, "Leftovers")).toHaveCount(0);
  await expect(page.locator(".today-wrap-line")).toHaveCount(0);
});

test("wrapping is two clicks — cancel writes nothing", async ({ page }) => {
  await page.locator(".today-wrap-act", { hasText: "Wrap the day" }).click();
  await page.locator(".today-wrap-act", { hasText: "Cancel" }).click();
  await expect(page.locator(".today-wrap-line")).toHaveCount(0);
  await expect(lane(page, "Leftovers")).toHaveCount(1);
});

test("focus makes one picked note the day's headline, on top", async ({ page }) => {
  const picked = lane(page, "Picked for today");
  // pick two, then crown the second: it has to jump the first
  const scheduled = lane(page, "Scheduled").locator(".today-row");
  await scheduled.first().locator(".today-act").click();
  await expect(picked.locator(".today-row")).toHaveCount(1);
  await scheduled.first().locator(".today-act").click();
  const rows = picked.locator(".today-row");
  await expect(rows).toHaveCount(2);
  const second = rows.nth(1);
  const title = await second.locator(".today-row-title").innerText();
  await second.locator(".today-act", { hasText: "Focus" }).click();
  await expect(rows.first().locator(".today-row-title")).toHaveText(title);
  await expect(rows.first()).toHaveClass(/headline/);
  await expect(rows.first().locator(".today-cursor")).toHaveText("focus");
  // only ever one headline
  await expect(picked.locator(".today-row.headline")).toHaveCount(1);
  await rows.first().locator(".today-act", { hasText: "Unfocus" }).click();
  await expect(picked.locator(".today-row.headline")).toHaveCount(0);
});
