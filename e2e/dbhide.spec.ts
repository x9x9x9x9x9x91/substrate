import { expect, test } from "./fixtures";

// A database removed from the sidebar. A homed database renders as
// its home folder's tree row; hiding takes that row (and its subtree) out of
// the Folders tree while leaving the folder, its files and the home
// assignment alone, so the All databases manager can put it back where it was.
// Distinct from "Stop opening as database", which keeps the row and drops the
// database behind it. Runs on the mock backend (fresh page = fresh vault).

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

/** the seeded homed database: the task db lives in Tasks/ */
const taskRow = (page: import("@playwright/test").Page) =>
  page
    .locator(".side-folder", { has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .filter({ has: page.locator(".side-db-chip") });

const managerRow = (page: import("@playwright/test").Page) =>
  page.locator(".dbmgr-row", { hasText: "Task" }).first();

const openManager = (page: import("@playwright/test").Page) =>
  page.locator(".side-item", { hasText: "All databases" }).click();

test("remove from sidebar takes the row and its subtree, show puts it back", async ({ page }) => {
  const row = taskRow(page);
  await expect(row).toBeVisible();

  // a subfolder under the home, so the hide has a subtree to take with it
  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New subfolder…" }).click();
  const input = page.locator('.side-folder input[placeholder="Folder name"]');
  await input.fill("Later");
  await input.press("Enter");
  const sub = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Later$/ }),
  });
  await expect(sub).toBeVisible();

  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove from sidebar" }).click();
  await expect(row).toHaveCount(0);
  await expect(sub).toHaveCount(0);

  // the database is still in the manager, marked
  await openManager(page);
  const mrow = managerRow(page);
  await expect(mrow).toHaveClass(/dbmgr-row-hidden/);
  await expect(mrow.locator(".dbmgr-tag")).toHaveText("hidden");
  // hiding is not un-homing: the home folder is still on the row
  await expect(mrow.locator(".dbmgr-row-sub")).toContainText("Tasks");

  // …and back: the row returns where it was, subtree included
  await mrow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Show in sidebar" }).click();
  await expect(taskRow(page)).toBeVisible();
  await expect(sub).toBeVisible();
  await expect(managerRow(page)).not.toHaveClass(/dbmgr-row-hidden/);
});

test("dragging a hidden database onto a folder shows it again", async ({ page }) => {
  await taskRow(page).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove from sidebar" }).click();
  await expect(taskRow(page)).toHaveCount(0);

  await openManager(page);
  await expect(managerRow(page)).toHaveClass(/dbmgr-row-hidden/);

  // the manager row is a drag source for set-home; dropping it on a tree
  // folder must also clear the hidden flag — dragging back always shows.
  // Synthetic DataTransfer, same reason as folderorder.spec.ts: Chromium's
  // mouse drag start slips the source row.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await managerRow(page).dispatchEvent("dragstart", { dataTransfer });
  const target = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Ideas$/ }),
  });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });

  // the row is back — at its new home, which is what the drop asked for
  const moved = page
    .locator(".side-folder", { has: page.locator(".side-label-text", { hasText: /^Ideas$/ }) })
    .filter({ has: page.locator(".side-db-chip") });
  await expect(moved).toBeVisible();
  await openManager(page);
  await expect(managerRow(page)).not.toHaveClass(/dbmgr-row-hidden/);
});

test("hiding and un-homing stay separate exits", async ({ page }) => {
  // "Stop opening as database" keeps the folder row and drops the database
  // behind it; the row menu of a VISIBLE database offers both
  await taskRow(page).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Remove from sidebar" })).toBeVisible();
  await page.locator(".ctx-item", { hasText: "Stop opening as database" }).click();

  const plain = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await expect(plain).toBeVisible();
  await expect(taskRow(page)).toHaveCount(0); // no DB chip any more

  // homeless now, so the sidebar row it would hide doesn't exist — the
  // manager offers the home lane instead of a hide it couldn't honour
  await openManager(page);
  await managerRow(page).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Remove from sidebar" })).toHaveCount(0);
  await expect(page.locator(".ctx-item", { hasText: "Set home folder…" })).toBeVisible();
});

test("a pin inside the hidden subtree survives, in a working flat lane", async ({ page }) => {
  // two pins: one on a vault-root note, which is always flat, and one on a
  // plain note filed INSIDE the database's home folder, which nests under the
  // Tasks row (pinned in Inbox first, then moved — the engine retargets the
  // pin, and the db pane is not a note list to right-click in)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await page.locator('.row[data-path="Welcome.md"]').click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();

  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  const note = page.locator('.row[data-path="Inbox/Capture anything.md"]');
  await note.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
  await expect(page.locator(".side-item", { hasText: "Capture anything" })).toBeVisible();
  await note.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to folder…" }).click();
  await page.locator(".palette-item", { hasText: /^Tasks$/ }).first().click();

  // the flat Pinned section — the wrapper div, so "which lane is this pin in"
  // is a question the assertions below can actually ask
  const pinnedSection = page
    .locator("div:has(> .side-label-row > .side-section-toggle)")
    .filter({ hasText: "Pinned" })
    .last();
  const pinTexts = async () =>
    (await pinnedSection.locator(".side-item .side-label-text").allTextContents()).filter((t) =>
      ["Welcome", "Capture anything"].includes(t)
    );
  // filed under Tasks now, so it nests on that tree row instead
  await expect(taskRow(page).locator(".side-chevron")).toHaveCount(1);
  expect(await pinTexts()).toEqual(["Welcome"]);

  await taskRow(page).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove from sidebar" }).click();
  await expect(taskRow(page)).toHaveCount(0);

  // the row it hung off is gone, so the pin falls back to the flat section
  // rather than vanishing with it
  expect(await pinTexts()).toEqual(["Welcome", "Capture anything"]);

  // …and it is a real member of that lane: Move up is live and swaps the
  // pair. The menu indexes the rescued row only if its math is hidden-aware
  await pinnedSection
    .locator(".side-item", { hasText: "Capture anything" })
    .click({ button: "right" });
  const moveUp = page.locator(".ctx-item", { hasText: "Move up" });
  await expect(moveUp).not.toHaveClass(/disabled/);
  await moveUp.click();
  expect(await pinTexts()).toEqual(["Capture anything", "Welcome"]);

  // now first in the lane, so Move up retires and Move down takes over
  await pinnedSection
    .locator(".side-item", { hasText: "Capture anything" })
    .click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveClass(/disabled/);
  await expect(page.locator(".ctx-item", { hasText: "Move down" })).not.toHaveClass(/disabled/);
});
