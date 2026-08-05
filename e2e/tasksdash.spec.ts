import { expect, test, type Page } from "@playwright/test";

// Tasks board v3 (SUB-870) over the mock seed (Dashboards/Tasks.md, areas
// Label/Studio/Admin). The board leads with urgency, so the seed lands as:
// Overdue = Chase the test pressing approvals (Label, high, −1d) then Renew
// Bandcamp plan (Admin, low, −2d, stale at 74d); Due today = Approve SMP-030
// artwork; Now = the `now: true` Master Vessel Songs v3 (due +2, so its pin
// still holds); area groups = Studio and Admin for the two upcoming rows; and
// Send SMP-029 promos sits in the collapsed Snoozed section. The remaining
// dense filler tasks carry no area, so the allowlist keeps them off entirely.

async function openTasks(page: Page) {
  await page.goto("/");
  // the Tasks DATABASE row carries a DB chip; the dashboard row doesn't
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await expect(page.locator(".dash-title")).toHaveText("Tasks");
}

test("tasks: the spine is urgency-first and the header counts what's pressing (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  await expect(page.locator(".dash-state")).toHaveText("2 overdue · 1 today · 1 now");
  await expect(page.locator(".tasks-group-name")).toHaveText([
    "Overdue",
    "Due today",
    "Now",
    "Studio",
    "Admin",
    "Snoozed",
  ]);

  // inside Overdue, priority outranks lateness: the high-priority row leads
  // even though the low one is a day later and 74 days old
  const overdue = page.locator(".tasks-overdue .tasks-row");
  await expect(overdue.locator(".tasks-title")).toHaveText([
    "Chase the test pressing approvals",
    "Renew Bandcamp plan",
  ]);
  // rot survives as a secondary chip, never as the reason the row is up here
  await expect(overdue.nth(1).locator(".tasks-finding")).toHaveText("stale");

  // due chips carry the urgency hue; an upcoming row gets the quiet variant
  await expect(page.locator(".tasks-today .tasks-due")).toHaveClass(/today/);
  await expect(overdue.first().locator(".tasks-due")).toHaveClass(/overdue/);
  await expect(
    page
      .locator(".tasks-row", { hasText: "Send the live-room recording quote" })
      .locator(".tasks-due")
  ).toHaveClass(/upcoming/);

  // priority renders as a schema-colored pill, not a tooltip-only value
  await expect(page.locator(".tasks-today .tasks-row .opt-pill")).toHaveText("High");

  // an undated row keeps its cell but renders the unset affordance, so the
  // grid geometry is identical whether or not a value exists
  const undated = page.locator(".tasks-row", { hasText: "Send the live-room recording quote" });
  await expect(undated.locator(".tasks-prio")).toHaveClass(/unset/);
  await expect(undated.locator(".tasks-prio")).toHaveText("＋ priority");
});

test("tasks: checkoff shows a checked state, toasts a real Undo, and ⌘Z also restores (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  const artwork = page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" });
  await expect(artwork).toHaveCount(1);
  // the checkbox is visible without hovering the row — it is the row's content
  await expect(artwork.locator(".tasks-check")).toBeVisible();
  await artwork.locator(".tasks-check").click();

  // status → done removes the row from the open cut; Due today empties out
  await expect(page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" })).toHaveCount(0);
  await expect(page.locator(".tasks-group-name", { hasText: /^Due today$/ })).toHaveCount(0);

  // the toast carries a real Undo action (SUB-870), not just a sentence
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Done — Approve SMP-030 artwork");
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" })).toHaveCount(1);

  // and ⌘Z runs the same entry — the write rode the shared undo stack
  await page
    .locator(".tasks-row", { hasText: "Renew Bandcamp plan" })
    .locator(".tasks-check")
    .click();
  await expect(page.locator(".tasks-row", { hasText: "Renew Bandcamp plan" })).toHaveCount(0);
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".tasks-row", { hasText: "Renew Bandcamp plan" })).toHaveCount(1);
});

test("tasks: the composer adds a task that lands on the board, not behind the allowlist (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  await page.locator(".tasks-compose-input").fill("Check the lacquer cut");
  await page.locator(".dash-add").click();

  // seeded with an allowed area (the allowlist's first), so it appears in a
  // group instead of vanishing into the filtered-out Unassigned
  const added = page.locator(".tasks-row", { hasText: "Check the lacquer cut" });
  await expect(added).toHaveCount(1);
  await expect(page.locator(".tasks-group-name", { hasText: /^Label$/ })).toHaveCount(1);
  // seeded created = today, so it reads 0d rather than as an undated finding
  await expect(added.locator(".tasks-age")).toHaveText("0d");
  await expect(added.locator(".tasks-finding")).toHaveCount(0);

  // REACHABLE, not merely present: urgency ranking sorts an undated new task
  // to the foot of its area, so the board scrolls to it and flashes it
  await expect(added).toBeInViewport();
  await expect(added).toHaveClass(/added/);
  // the flash is a moment, not a permanent state
  await expect(added).not.toHaveClass(/added/, { timeout: 4000 });
});

test("tasks: the composer can set a due date, landing the new task in a dated section (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  await page.locator(".tasks-compose-due").click();
  await page.locator(".datemenu button", { hasText: /^Today$/ }).click();
  await expect(page.locator(".tasks-compose-due")).toHaveText("Today");

  await page.locator(".tasks-compose-input").fill("Check the lacquer cut");
  await page.locator(".dash-add").click();

  // with a due date it skips the area group entirely and joins Due today,
  // where it is visible without hunting
  const added = page.locator(".tasks-today .tasks-row", { hasText: "Check the lacquer cut" });
  await expect(added).toHaveCount(1);
  await expect(added).toBeInViewport();
  await expect(added.locator(".tasks-due")).toHaveText("Today");
  // the composer resets for the next task
  await expect(page.locator(".tasks-compose-input")).toHaveValue("");
  await expect(page.locator(".tasks-compose-due")).toHaveText("＋ due");
});

test("tasks: the due chip edits the date inline and re-sections the row (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  // an upcoming Studio row: clicking its due chip opens the picker
  const quote = page.locator(".tasks-row", { hasText: "Send the live-room recording quote" });
  await quote.hover();
  await quote.locator(".tasks-due").click();
  await expect(page.locator(".datemenu")).toHaveCount(1);
  await page.locator(".datemenu button", { hasText: /^Today$/ }).click();

  // the write lands through the same undoable path the verbs use, so the row
  // moves to Due today and the toast offers Undo
  await expect(page.locator(".tasks-today .tasks-row", { hasText: "Send the live-room recording quote" })).toHaveCount(1);
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Send the live-room recording quote");
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(page.locator(".tasks-group-name", { hasText: /^Studio$/ })).toHaveCount(1);
});

test("tasks: the priority pill edits priority inline, including on a row with none (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  // the seeded quote row carries no priority — its placeholder is the affordance
  const quote = page.locator(".tasks-row", { hasText: "Send the live-room recording quote" });
  await expect(quote.locator(".opt-pill")).toHaveCount(0);
  await quote.hover();
  await quote.locator(".tasks-prio").click();

  // the picker offers the task type's own schema options
  await expect(page.locator(".selmenu")).toHaveCount(1);
  await expect(page.locator(".selmenu-item").filter({ hasText: /^(High|Medium|Low)$/ })).toHaveCount(3);
  await page.locator(".selmenu-item", { hasText: "High" }).first().click();

  await expect(quote.locator(".opt-pill")).toHaveText("High");
  const toast = page.locator(".toast");
  await expect(toast).toContainText("High — Send the live-room recording quote");
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(quote.locator(".opt-pill")).toHaveCount(0);
});

test("tasks: Now/Later verbs move a row between the focus card and its group (SUB-786)", async ({
  page,
}) => {
  await openTasks(page);

  // pin an upcoming row: it joins Now and leaves its group
  const quote = page.locator(".tasks-row", { hasText: "Send the live-room recording quote" });
  await quote.hover();
  await quote.locator(".tasks-act", { hasText: /^Now$/ }).click();
  const nowGroup = page.locator(".tasks-group.tasks-now");
  await expect(nowGroup.locator(".tasks-row")).toHaveCount(2);
  await expect(page.locator(".tasks-group-name", { hasText: /^Studio$/ })).toHaveCount(0);

  // the pin glyph follows the pin (SUB-1109): both Now rows carry it, the
  // overdue rows below carry none
  await expect(nowGroup.locator(".tasks-row .tasks-pin")).toHaveCount(2);
  await expect(page.locator(".tasks-overdue .tasks-row .tasks-pin")).toHaveCount(0);

  // unpin the original pin: Master Vessel returns to Studio, group reappears
  const vessel = nowGroup.locator(".tasks-row", { hasText: "Master Vessel Songs v3" });
  await vessel.hover();
  await vessel.locator(".tasks-act", { hasText: /^Later$/ }).click();
  await expect(nowGroup.locator(".tasks-row")).toHaveCount(1);
  await expect(page.locator(".tasks-group-name", { hasText: /^Studio$/ })).toHaveCount(1);
  // unpinned, it drops the glyph with the pin rather than keeping a stale mark
  await expect(
    page
      .locator(".tasks-group.tasks-area .tasks-row", { hasText: "Master Vessel Songs v3" })
      .locator(".tasks-pin")
  ).toHaveCount(0);
});

test("tasks: snooze parks a row into the Snoozed section and Wake brings it back (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  // the seeded promos row is parked: hidden from the board, listed with its
  // wake date under the collapsed section
  await expect(
    page.locator(".tasks-board .tasks-row", { hasText: "Send SMP-029 promos" })
  ).toHaveCount(0);
  await expect(page.locator(".tasks-snoozed .tasks-group-count")).toHaveText("1");
  await page.locator(".tasks-snoozed-toggle").click();
  const parked = page.locator(".tasks-row.parked", { hasText: "Send SMP-029 promos" });
  await expect(parked.locator(".tasks-wake")).toContainText("wakes");

  // Wake clears snoozed_until — the row rejoins the board, the section goes
  await parked.hover();
  await parked.locator(".tasks-act", { hasText: "Wake" }).click();
  await expect(page.locator(".tasks-snoozed")).toHaveCount(0);
  await expect(
    page.locator(".tasks-board .tasks-row", { hasText: "Send SMP-029 promos" })
  ).toHaveCount(1);

  // snoozing it again from the board round-trips the other way
  const promos = page.locator(".tasks-row", { hasText: "Send SMP-029 promos" });
  await promos.hover();
  await promos.locator(".tasks-act", { hasText: /^Snooze$/ }).click();
  await page.locator(".ctx-item", { hasText: "For a week" }).click();
  await expect(page.locator(".tasks-snoozed .tasks-group-count")).toHaveText("1");
});

test("tasks: the snooze menu offers a date picker anchored to its verb (SUB-870)", async ({
  page,
}) => {
  await openTasks(page);

  const quote = page.locator(".tasks-row", { hasText: "Send the live-room recording quote" });
  await quote.hover();
  const verb = quote.locator(".tasks-act", { hasText: /^Snooze$/ });
  const verbBox = await verb.boundingBox();
  await verb.click();
  await expect(page.locator(".ctx-item")).toHaveText([
    "Until tomorrow",
    "For a week",
    "For a month",
    "Pick date…",
  ]);

  await page.locator(".ctx-item", { hasText: "Pick date…" }).click();
  const picker = page.locator(".datemenu");
  await expect(picker).toHaveCount(1);
  // anchored to the verb's RECT (anchorFrom), not to wherever the pointer sat:
  // left is the verb's left clamped inside the viewport, and the panel meets
  // one of the verb's own horizontal edges — under its bottom, or flipped
  // above its top when the bottom of the window is close. A click-coordinate
  // anchor would land on the pointer's y, mid-row, matching neither.
  const width = await page.evaluate(() => window.innerWidth);
  // measured once the pop-in has settled (SUB-945 gave every anchored menu the
  // same short entrance) -- the assertion itself stays exact, so a menu that is
  // genuinely anchored to the pointer never converges
  await expect(async () => {
    const box = await picker.boundingBox();
    expect(box?.x).toBeCloseTo(Math.min(verbBox?.x ?? 0, width - 268), 0);
    const under = (verbBox?.y ?? 0) + (verbBox?.height ?? 0) + 4;
    const flippedAbove = (verbBox?.y ?? 0) - 4 - (box?.height ?? 0);
    expect(
      Math.min(Math.abs((box?.y ?? 0) - under), Math.abs((box?.y ?? 0) - flippedAbove))
    ).toBeLessThan(1);
  }).toPass({ timeout: 2000 });
});

test("tasks: the Board view groups every open row by area, urgency claiming nothing (SUB-933)", async ({
  page,
}) => {
  await openTasks(page);

  await page.locator(".tasks-view button", { hasText: /^Board$/ }).click();
  // one column per allowlisted area, in the allowlist's order; the snoozed
  // promo row stays off the board here too
  await expect(page.locator(".tasks-col-name")).toHaveText(["Label", "Studio", "Admin"]);
  await expect(page.locator(".tasks-cols")).toBeVisible();
  await expect(page.locator(".tasks-board")).toHaveCount(0);

  // the overdue and pinned rows sit in their home columns as cards — the
  // list's Overdue/Now sections never relocate a card on the board
  const label = page.locator(".tasks-col", { has: page.locator(".tasks-col-name", { hasText: /^Label$/ }) });
  await expect(label.locator(".tasks-card .tasks-title")).toHaveText([
    "Chase the test pressing approvals",
    "Approve SMP-030 artwork",
  ]);
  const admin = page.locator(".tasks-col", { has: page.locator(".tasks-col-name", { hasText: /^Admin$/ }) });
  await expect(admin.locator(".tasks-card .tasks-title")).toHaveText([
    "Renew Bandcamp plan",
    "Renew the webshop shipping rates",
  ]);

  // the pinned card wears the pin glyph (SUB-1109): on the board there is no
  // Now heading, so the mark is the only thing saying the missing stale chip
  // is an exemption. An unpinned card carries none — including the 74-day
  // Bandcamp row, which is chipped `stale` precisely because it isn't pinned.
  const studio = page.locator(".tasks-col", {
    has: page.locator(".tasks-col-name", { hasText: /^Studio$/ }),
  });
  await expect(
    studio.locator(".tasks-card", { hasText: "Master Vessel Songs v3" }).locator(".tasks-pin")
  ).toHaveCount(1);
  await expect(
    admin.locator(".tasks-card", { hasText: "Renew Bandcamp plan" }).locator(".tasks-pin")
  ).toHaveCount(0);

  // cards keep the row's verbs: checkoff works from the board
  const bandcamp = page.locator(".tasks-card", { hasText: "Renew Bandcamp plan" });
  await bandcamp.locator(".tasks-check").click();
  await expect(page.locator(".tasks-card", { hasText: "Renew Bandcamp plan" })).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("Done — Renew Bandcamp plan");

  // the choice persists to the dashboard note's frontmatter and survives a
  // reopen; List clears it again
  await page.locator(".side-item", { hasText: /^Today/ }).first().click();
  await expect(page.locator(".today-head .today-eyebrow")).toHaveText("Today");
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await expect(page.locator(".dash-title")).toHaveText("Tasks");
  await expect(page.locator(".tasks-cols")).toBeVisible();
  await page.locator(".tasks-view button", { hasText: /^List$/ }).click();
  await expect(page.locator(".tasks-board")).toBeVisible();
});

test("tasks: the sort switch re-ranks sections and columns and persists (SUB-933)", async ({
  page,
}) => {
  await openTasks(page);

  // urgency default inside Overdue: high priority leads (SUB-870 assertion)
  const overdue = page.locator(".tasks-overdue .tasks-row");
  await expect(overdue.locator(".tasks-title")).toHaveText([
    "Chase the test pressing approvals",
    "Renew Bandcamp plan",
  ]);

  // Age leads with the oldest row: the 74-day Bandcamp renewal now tops it
  await page.locator(".tasks-sort button", { hasText: /^Age$/ }).click();
  await expect(overdue.locator(".tasks-title")).toHaveText([
    "Renew Bandcamp plan",
    "Chase the test pressing approvals",
  ]);

  // the same ordering feeds the board's columns
  await page.locator(".tasks-view button", { hasText: /^Board$/ }).click();
  const studio = page.locator(".tasks-col", { has: page.locator(".tasks-col-name", { hasText: /^Studio$/ }) });
  await expect(studio.locator(".tasks-card .tasks-title")).toHaveText([
    "Master Vessel Songs v3",
    "Send the live-room recording quote",
  ]);

  // Due on the board, asserted where it actually disagrees with its
  // neighbours: Admin's two cards run Medium-but-later against Low-but-overdue,
  // so Priority and Due invert the column against each other. Studio and Label
  // would order the same under either, which is no evidence the click landed.
  const admin = page.locator(".tasks-col", { has: page.locator(".tasks-col-name", { hasText: /^Admin$/ }) });
  await page.locator(".tasks-sort button", { hasText: /^Priority$/ }).click();
  await expect(admin.locator(".tasks-card .tasks-title")).toHaveText([
    "Renew the webshop shipping rates",
    "Renew Bandcamp plan",
  ]);
  await page.locator(".tasks-sort button", { hasText: /^Due$/ }).click();
  await expect(admin.locator(".tasks-card .tasks-title")).toHaveText([
    "Renew Bandcamp plan",
    "Renew the webshop shipping rates",
  ]);

  // both prefs survive a reopen together
  await page.locator(".side-item", { hasText: /^Today/ }).first().click();
  await expect(page.locator(".today-head .today-eyebrow")).toHaveText("Today");
  await page
    .locator(".side-item", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ hasNot: page.locator(".side-db-chip") })
    .first()
    .click();
  await expect(page.locator(".dash-title")).toHaveText("Tasks");
  await expect(page.locator(".tasks-sort button", { hasText: /^Due$/ })).toHaveClass(/active/);
  await expect(page.locator(".tasks-cols")).toBeVisible();
});

test("tasks: dragging a card to another column rewrites its area with Undo (SUB-933)", async ({
  page,
}) => {
  await openTasks(page);
  await page.locator(".tasks-view button", { hasText: /^Board$/ }).click();

  const card = page.locator(".tasks-card", { hasText: "Renew the webshop shipping rates" });
  const studio = page.locator(".tasks-col", { has: page.locator(".tasks-col-name", { hasText: /^Studio$/ }) });
  await card.dragTo(studio);

  // the card moved columns; the toast names the target and offers Undo
  await expect(studio.locator(".tasks-card", { hasText: "Renew the webshop shipping rates" })).toHaveCount(1);
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Renew the webshop shipping rates → Studio");
  await toast.locator("button", { hasText: "Undo" }).click();
  const admin = page.locator(".tasks-col", { has: page.locator(".tasks-col-name", { hasText: /^Admin$/ }) });
  await expect(admin.locator(".tasks-card", { hasText: "Renew the webshop shipping rates" })).toHaveCount(1);
});

test("tasks: a card's move menu re-areas it without a drag, by pointer and by key (SUB-1053)", async ({
  page,
}) => {
  await openTasks(page);
  await page.locator(".tasks-view button", { hasText: /^Board$/ }).click();

  const studio = page.locator(".tasks-col", {
    has: page.locator(".tasks-col-name", { hasText: /^Studio$/ }),
  });
  const label = page.locator(".tasks-col", {
    has: page.locator(".tasks-col-name", { hasText: /^Label$/ }),
  });

  // right-click offers one entry per column, and the card's own column is
  // listed but inert — the menu can never name a target a drop couldn't reach
  const artwork = page.locator(".tasks-card", { hasText: "Approve SMP-030 artwork" });
  await artwork.click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-label")).toHaveText([
    "Move to Label",
    "Move to Studio",
    "Move to Admin",
  ]);
  await expect(page.locator(".ctx-item", { hasText: "Move to Label" })).toHaveClass(/disabled/);

  await page.locator(".ctx-item", { hasText: "Move to Admin" }).click();
  const admin = page.locator(".tasks-col", {
    has: page.locator(".tasks-col-name", { hasText: /^Admin$/ }),
  });
  await expect(admin.locator(".tasks-card", { hasText: "Approve SMP-030 artwork" })).toHaveCount(1);

  // the same undoable write the drop takes: the toast names the target and
  // Undo puts the card back in its old column
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Approve SMP-030 artwork → Admin");
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(label.locator(".tasks-card", { hasText: "Approve SMP-030 artwork" })).toHaveCount(1);

  // and the whole path is reachable from the keyboard: Shift+F10 on anything
  // focused inside the card opens the same menu, arrows and Enter pick
  const chase = page.locator(".tasks-card", { hasText: "Chase the test pressing approvals" });
  await chase.locator(".tasks-open").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(".ctx-menu")).toBeVisible();
  // the first stop skips the disabled current column and lands on Studio
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    studio.locator(".tasks-card", { hasText: "Chase the test pressing approvals" })
  ).toHaveCount(1);
  await expect(page.locator(".toast")).toContainText("Chase the test pressing approvals → Studio");
});

test("tasks: board cards carry the rot layer the list rows do (SUB-1055)", async ({ page }) => {
  await openTasks(page);
  await page.locator(".tasks-view button", { hasText: /^Board$/ }).click();

  // the seeded 74-day-old task is the rot fixture: in the list it wears an
  // amber "stale" chip, and the board dropped it entirely — a card could be
  // two months dead and look identical to one filed this morning
  const bandcamp = page.locator(".tasks-card", { hasText: "Renew Bandcamp plan" });
  await expect(bandcamp.locator(".tasks-finding")).toHaveText("stale");

  // it is a finding, not decoration: a task that is merely late carries none.
  // Its `created` is seeded 3 days back RELATIVE to today, not at the seed's
  // FIXED_BASE — a fixed date would drift past stale_days as the calendar
  // moves and turn this negative case permanently red (SUB-1055 review)
  const chase = page.locator(".tasks-card", { hasText: "Chase the test pressing approvals" });
  await expect(chase.locator(".tasks-finding")).toHaveCount(0);

  // age stays in the tooltip — no third number on a 240px meta line
  await expect(bandcamp).toHaveAttribute("title", /Created 74 days ago/);
  await expect(chase).toHaveAttribute("title", /Created 3 days ago/);
});
