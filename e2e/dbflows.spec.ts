import { expect, test } from "@playwright/test";

// SUB-403: the sidebar's two database-into-tree flows. The Folders "+" is an
// add menu — plain inline folder create, a database that lands in the tree
// on an eponymous root folder, or "Map a folder…" backing a database with a
// real folder on disk (SUB-672) — and All-databases manager rows
// drag onto sidebar folders to set their home (SUB-85 IPC, toast confirms).
// SUB-411 adds the inverse: the tree row's "Stop opening as database" un-homes
// in place. Runs against the deterministic mock backend (fresh page =
// fresh vault).

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("Folders '+' opens the add menu; New folder keeps the inline flow", async ({ page }) => {
  await page.locator(".side-add").click();
  const items = page.locator(".ctx-item");
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: "New folder" })).toHaveCount(1);
  await expect(items.filter({ hasText: "New database…" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Map a folder…" })).toHaveCount(1);
  await expect(items.filter({ hasText: "New tag folder…" })).toHaveCount(1);

  // the plain new-folder flow is unchanged: inline edit row, Enter creates
  await items.filter({ hasText: "New folder" }).click();
  const input = page.locator('.side-folder input[placeholder="Folder name"]');
  await expect(input).toBeVisible();
  await input.fill("Stuff");
  await input.press("Enter");
  await expect(
    page.locator(".side-folder", { has: page.locator(".side-label-text", { hasText: /^Stuff$/ }) })
  ).toHaveCount(1);
});

test("New database… from the sidebar homes the new database in the tree", async ({ page }) => {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();

  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".dbform-input").first().fill("Rig");

  // property kind + relation target ride the in-house SelectMenu (SUB-647) —
  // open, pick, commit for both replaced controls
  await form.locator(".dbform-addprop").click();
  const propRow = form.locator(".dbform-proprow");
  await propRow.locator(".dbform-input").fill("vendor");
  const kindBtn = propRow.locator(".dbform-select").first();
  await expect(kindBtn).toHaveText("Text");
  await kindBtn.click();
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  // Esc closes just the menu, not the dialog
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(form).toBeVisible();
  await kindBtn.click();
  await menu.locator(".selmenu-item", { hasText: "Relation" }).click();
  await expect(menu).toHaveCount(0);
  await expect(kindBtn).toHaveText("Relation");
  // choosing relation reveals the target picker — also SelectMenu-driven
  const targetBtn = propRow.locator(".dbform-select").nth(1);
  await expect(targetBtn).toBeVisible();
  await targetBtn.click();
  await expect(menu).toBeVisible();
  await menu.locator(".selmenu-item", { hasText: "task" }).click();
  await expect(targetBtn).toHaveText("task");

  await form.locator(".selmenu-btn-primary").click();

  // the create flow's landing view opens…
  await expect(page.locator(".list-title")).toHaveText("Rig");
  // …and the eponymous root folder, set as the db's home, renders it in the
  // tree right away — the row is the database (icon, label, count)
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Rig$/ }),
  });
  await expect(treeRow).toBeVisible();
  await treeRow.locator(".side-destination").click();
  await expect(page.locator(".list-title")).toHaveText("Rig");
});

test("New database… reuses an existing eponymous folder, never a 'Name 2'", async ({ page }) => {
  // Inbox is a seeded mock folder — a database named inbox must home INTO it
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await form.locator(".dbform-input").first().fill("inbox");
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");

  // exactly one Inbox tree row, and the manager proves the home is "Inbox"
  await expect(
    page.locator(".side-folder", {
      has: page.locator(".side-label-text", { hasText: /^Inbox$/ }),
    })
  ).toHaveCount(1);
  await expect(page.locator(".side-folder", { hasText: "Inbox 2" })).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(
    page.locator(".dbmgr-row", { hasText: "Inbox" }).locator(".dbmgr-row-sub")
  ).toHaveText("0 entries · Inbox");
});

test("dragging a manager row onto a sidebar folder sets its home", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const releaseRow = page.locator(".dbmgr-row", { hasText: "Release" });
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries");

  const projects = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Projects$/ }),
  });
  await releaseRow.dragTo(projects);

  // toast confirms, the manager sub gains the home segment…
  await expect(page.locator(".toast")).toContainText("now lives in");
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries · Projects");
  // …and the tree row db-dresses (folder name + DB chip, SUB-611),
  // click-through to the database view
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Projects$/ }),
  }).filter({ has: page.locator(".side-db-chip") });
  await expect(treeRow).toBeVisible();
  await treeRow.locator(".side-destination").click();
  await expect(page.locator(".list-title")).toHaveText("Release");
});

test("dropping a database on its own home row is a quiet no-op", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const taskRow = page.locator(".dbmgr-row", { hasText: "Task" });
  // the seeded home (task → Tasks) db-dresses the tree row (folder name +
  // DB chip, SUB-611)
  const tasksRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await expect(tasksRow).toBeVisible();

  await taskRow.dragTo(tasksRow);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(taskRow.locator(".dbmgr-row-sub")).toHaveText("17 entries · Tasks");
});

test("'Stop opening as database' on the tree row un-homes without deleting (SUB-411)", async ({
  page,
}) => {
  // the seeded task db dresses its Tasks home row (SUB-85, SUB-611 label)
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await expect(treeRow).toBeVisible();
  await expect(treeRow.locator(".side-db-chip")).toHaveText("DB");

  // the tree row's own context menu carries the non-destructive exit lane
  await treeRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Stop opening as database" }).click();

  // toast confirms; the row reverts to the plain Tasks folder — same name,
  // chip gone (the home folder itself survives, only the schema home clears)…
  await expect(page.locator(".toast")).toContainText("back to plain files");
  await expect(treeRow.locator(".side-db-chip")).toHaveCount(0);
  await expect(treeRow).toBeVisible();

  // …and the database still lists in All databases, now homeless
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(
    page.locator(".dbmgr-row", { hasText: "Task" }).locator(".dbmgr-row-sub")
  ).toHaveText("17 entries");
});

test("folder 'Open as database…' homes an existing db on that folder (SUB-611)", async ({
  page,
}) => {
  // Ideas is a plain seeded folder — its menu carries the entry lane
  const ideasRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Ideas$/ }),
  });
  await expect(ideasRow).toBeVisible();
  await expect(ideasRow.locator(".side-db-chip")).toHaveCount(0);

  await ideasRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Open as database…" }).click();
  // second stage: existing databases plus the New database… tail
  await page.locator(".ctx-item", { hasText: /^Release$/ }).click();

  // the row db-dresses in place: same folder name, DB chip, db view on click
  await expect(page.locator(".toast")).toContainText("now lives in");
  await expect(ideasRow.locator(".side-db-chip")).toHaveText("DB");
  await ideasRow.locator(".side-destination").click();
  await expect(page.locator(".list-title")).toHaveText("Release");
});

test("folder 'Open as database…' births a new db homed on that folder (SUB-611)", async ({
  page,
}) => {
  const ideasRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Ideas$/ }),
  });
  await ideasRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Open as database…" }).click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();

  const form = page.locator(".dbform");
  await form.locator(".dbform-input").first().fill("Sketch");
  await form.locator(".selmenu-btn-primary").click();

  // the new db homes on Ideas itself — no eponymous "Sketch" root folder
  await expect(page.locator(".list-title")).toHaveText("Sketch");
  await expect(ideasRow.locator(".side-db-chip")).toHaveText("DB");
  await expect(
    page.locator(".side-folder", { has: page.locator(".side-label-text", { hasText: /^Sketch$/ }) })
  ).toHaveCount(0);
});

test("db-dressed row: New subfolder… creates a real subfolder under it (SUB-611)", async ({
  page,
}) => {
  const tasksRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await tasksRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "New subfolder…" }).click();
  const input = page.locator('.side-folder input[placeholder="Folder name"]');
  await input.fill("Done pile");
  await input.press("Enter");

  // the subfolder nests under the db-dressed row as a PLAIN folder row —
  // no db styling inherited
  const sub = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Done pile$/ }),
  });
  await expect(sub).toBeVisible();
  await expect(sub.locator(".side-db-chip")).toHaveCount(0);
  await sub.locator(".side-destination").click();
  await expect(page.locator(".list-title")).toHaveText("Done pile");
  await expect(page.locator(".list-head .head-kind")).toHaveText("Folder");
});
