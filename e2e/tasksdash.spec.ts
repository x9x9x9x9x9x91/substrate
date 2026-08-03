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

  // unpin the original pin: Master Vessel returns to Studio, group reappears
  const vessel = nowGroup.locator(".tasks-row", { hasText: "Master Vessel Songs v3" });
  await vessel.hover();
  await vessel.locator(".tasks-act", { hasText: /^Later$/ }).click();
  await expect(nowGroup.locator(".tasks-row")).toHaveCount(1);
  await expect(page.locator(".tasks-group-name", { hasText: /^Studio$/ })).toHaveCount(1);
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
  const box = await picker.boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  expect(box?.x).toBeCloseTo(Math.min(verbBox?.x ?? 0, width - 268), 0);
  const under = (verbBox?.y ?? 0) + (verbBox?.height ?? 0) + 4;
  const flippedAbove = (verbBox?.y ?? 0) - 4 - (box?.height ?? 0);
  expect(Math.min(Math.abs((box?.y ?? 0) - under), Math.abs((box?.y ?? 0) - flippedAbove))).toBeLessThan(1);
});
