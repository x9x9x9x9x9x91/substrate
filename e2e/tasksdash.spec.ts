import { expect, test, type Page } from "@playwright/test";

// Tasks dashboard v2 (SUB-786) over the mock seed (Dashboards/Tasks.md,
// areas Label/Studio/Admin): Master Vessel Songs v3 is pinned `now: true`
// (Studio, 46d old — no stale finding in the Now section by design),
// Approve SMP-030 artwork is an ordinary Label row, Renew Bandcamp plan is
// stale in Admin, and Send SMP-029 promos is snoozed a week out — hidden
// from the groups, counted in the header. The 13 dense filler tasks carry
// no area, so the allowlist keeps them off this board entirely.

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

test("tasks: Now section pins cross-area without findings; snoozed counts in the header", async ({
  page,
}) => {
  await openTasks(page);

  // header: Renew Bandcamp plan is the one stale Later row; promos snoozed
  await expect(page.locator(".dash-state")).toHaveText("1 need attention · 1 snoozed");

  // Now leads with the pinned task; its 46d age raises no chip there
  const nowGroup = page.locator(".tasks-group.tasks-now");
  await expect(nowGroup.locator(".tasks-group-name")).toHaveText("Now");
  const pinned = nowGroup.locator(".tasks-row");
  await expect(pinned).toHaveCount(1);
  await expect(pinned).toContainText("Master Vessel Songs v3");
  await expect(pinned.locator(".tasks-finding")).toHaveCount(0);
  await expect(pinned).toHaveClass(/quiet/);

  // the pinned task left its Studio group — with nothing else there, the
  // group disappears instead of rendering empty
  await expect(page.locator(".tasks-group-name", { hasText: /^Studio$/ })).toHaveCount(0);

  // the snoozed promos row is nowhere on the board
  await expect(page.locator(".tasks-row", { hasText: "Send SMP-029 promos" })).toHaveCount(0);

  // the stale Admin row keeps its finding chip in the Later layer
  const bandcamp = page.locator(".tasks-row", { hasText: "Renew Bandcamp plan" });
  await expect(bandcamp.locator(".tasks-finding")).toHaveText("stale");
});

test("tasks: checkoff completes from the board and ⌘Z brings the row back (SUB-786)", async ({
  page,
}) => {
  await openTasks(page);

  const artwork = page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" });
  await expect(artwork).toHaveCount(1);
  await artwork.locator(".tasks-check").click();

  // status → done removes the row from the open cut; Label group empties out
  await expect(page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" })).toHaveCount(0);
  await expect(page.locator(".tasks-group-name", { hasText: /^Label$/ })).toHaveCount(0);

  // one ⌘Z restores it — the write rode the shared undo stack (setPropUndoable)
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" })).toHaveCount(1);
});

test("tasks: Now/Later verbs move a row between the focus list and its group", async ({
  page,
}) => {
  await openTasks(page);

  // pin the Label row: it joins Now and leaves its group
  const artwork = page.locator(".tasks-row", { hasText: "Approve SMP-030 artwork" });
  await artwork.hover();
  await artwork.locator(".tasks-act", { hasText: /^Now$/ }).click();
  const nowGroup = page.locator(".tasks-group.tasks-now");
  await expect(nowGroup.locator(".tasks-row")).toHaveCount(2);
  await expect(page.locator(".tasks-group-name", { hasText: /^Label$/ })).toHaveCount(0);

  // unpin the original pin: Master Vessel returns to Studio, group reappears
  const vessel = nowGroup.locator(".tasks-row", { hasText: "Master Vessel Songs v3" });
  await vessel.hover();
  await vessel.locator(".tasks-act", { hasText: /^Later$/ }).click();
  await expect(nowGroup.locator(".tasks-row")).toHaveCount(1);
  await expect(page.locator(".tasks-group-name", { hasText: /^Studio$/ })).toHaveCount(1);
});

test("tasks: snooze hides the row and moves it into the header tally", async ({ page }) => {
  await openTasks(page);

  const bandcamp = page.locator(".tasks-row", { hasText: "Renew Bandcamp plan" });
  await bandcamp.hover();
  await bandcamp.locator(".tasks-act", { hasText: /^Snooze$/ }).click();
  await page.locator(".ctx-item", { hasText: "For a week" }).click();

  await expect(page.locator(".tasks-row", { hasText: "Renew Bandcamp plan" })).toHaveCount(0);
  // it was the only attention row, so the header flips to the open count:
  // Master Vessel (Now) + Approve SMP-030 — with two snoozed below
  await expect(page.locator(".dash-state")).toHaveText("2 open · 2 snoozed");
});
