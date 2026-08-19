import { expect, test, type Page } from "@playwright/test";

// Dashboards living in a subfolder of their home folder render under
// a collapsible group header, and a dashboard moves between folders by drag or
// by the row's "Move to folder…" picker.

/** The Dashboards section's group header rows, by label. */
function dashGroup(page: Page, name: string) {
  return page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: name }),
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Umbra Home", exact: true })).toBeVisible();
});

test("a subfoldered dashboard renders under a group header and opens", async ({ page }) => {
  const group = dashGroup(page, "Releases");
  await expect(group).toHaveCount(1);
  // Dropped the header's member count — the rows under it say it all
  await expect(group.locator(".side-count")).toHaveCount(0);

  // the grouped row sits under the header, the flat ones stay above it
  const grouped = page.getByRole("button", { name: "Label Health", exact: true });
  await expect(grouped).toBeVisible();
  await grouped.click();
  await expect(page.locator(".dash-title")).toHaveText("Label Health");

  // the chevron collapses the group through the persisted collapsedIds
  const chevron = group.getByRole("button", { name: "Collapse Releases" });
  await chevron.click();
  await expect(grouped).toHaveCount(0);
  await group.getByRole("button", { name: "Expand Releases" }).click();
  await expect(grouped).toBeVisible();

  // …and the flat dashboards are unaffected
  await expect(page.getByRole("button", { name: "Umbra Home", exact: true })).toBeVisible();
});

test("dropping a dashboard on its OWN group header stays a no-op", async ({ page }) => {
  // The own-folder-drop-pins gesture must not apply to
  // sidebar row drags — a dashboard dropped back on its own group header used
  // to be a silent no-op, and pinning it here would render it twice (its pin
  // routes to the flat Pinned section, since Dashboards is a hidden root)
  const group = dashGroup(page, "Releases");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const grouped = page.getByRole("button", { name: "Label Health", exact: true });
  await grouped.dispatchEvent("dragstart", { dataTransfer });
  await group.dispatchEvent("dragover", { dataTransfer });
  await group.dispatchEvent("drop", { dataTransfer });

  // still exactly one row, no Pinned section born from the gesture
  await expect(page.getByRole("button", { name: "Label Health", exact: true })).toHaveCount(1);
  await expect(page.locator(".side-section-toggle", { hasText: "Pinned" })).toHaveCount(0);
});

test("dragging a flat dashboard onto a group header moves the file", async ({ page }) => {
  const group = dashGroup(page, "Releases");
  await expect(group).toHaveCount(1);
  // pre-state: Overview is a FLAT dashboard, not yet a Releases member —
  // collapsing the group must not hide it (the header count this used to
  // assert is gone, so membership is proven by collapse visibility)
  await group.getByRole("button", { name: "Collapse Releases" }).click();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
  await group.getByRole("button", { name: "Expand Releases" }).click();

  // Chromium's synthetic-mouse drag start slips the source row (see
  // folderorder.spec.ts), so dispatch with an explicit DataTransfer — the
  // app's own dragstart / dragover / drop handlers do the work
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const overview = page.getByRole("button", { name: "Overview", exact: true });
  await overview.dispatchEvent("dragstart", { dataTransfer });
  await group.dispatchEvent("dragover", { dataTransfer });
  await group.dispatchEvent("drop", { dataTransfer });

  // Overview joined the group (the header count is gone, so prove
  // membership by collapse: a group member vanishes with its header closed)
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
  await expect(dashGroup(page, "Releases")).toHaveCount(1);
  await group.getByRole("button", { name: "Collapse Releases" }).click();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveCount(0);
  await group.getByRole("button", { name: "Expand Releases" }).click();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
});

test("dragging a dashboard onto the Pinned header does not pin it", async ({ page }) => {
  // A dashboard drag carries NOTE_DRAG_MIME so it can
  // land on a folder, and the Pinned drop zone used to take any note payload —
  // so a drag aimed at the Pinned header pinned the dashboard and rendered it
  // twice in the sidebar. A drag that also carries SIDE_DRAG_MIME is a sidebar
  // row gesture, never "pin this".

  // seed a pin from a plain ROOT note so the flat Pinned section (the drop
  // target) exists — a folder note's pin nests in the tree instead
  await page.locator(".side-item", { hasText: "All notes" }).click();
  const note = page.locator('.row[data-path="Welcome.md"]');
  await expect(note).toBeVisible();
  await note.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
  const header = page.locator(".side-label-row", { hasText: "Pinned" });
  await expect(header).toBeVisible();
  // leave the All-notes list (it holds an "Overview" ROW that would make the
  // sidebar's Overview locator ambiguous)
  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  await expect(page.locator(".list-title")).toHaveText("Inbox");

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const overview = page.getByRole("button", { name: "Overview", exact: true });
  await overview.dispatchEvent("dragstart", { dataTransfer });
  await header.dispatchEvent("dragover", { dataTransfer });
  await header.dispatchEvent("drop", { dataTransfer });

  // no pin created: the dashboard still has exactly one sidebar row, and the
  // Pinned section still holds only the seeded note
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toHaveCount(1);
  await expect(page.locator(".side-item", { hasText: "Welcome" })).toHaveCount(1);

  // and the header never lit up as a live drop target during the drag
  await expect(header).not.toHaveClass(/drop-target/);
});

test("Move to folder… moves a grouped dashboard back out, order survives", async ({ page }) => {
  await page.getByRole("button", { name: "Label Health", exact: true }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to folder…" }).click();
  // the scoped picker lists the dashboards' home folder and its subfolders
  await expect(page.locator(".ctx-item", { hasText: "Dashboards/Releases" })).toHaveClass(
    /disabled/
  );
  await page.locator(".ctx-item").filter({ hasText: /^Dashboards$/ }).click();

  // out of the group and back into the flat list — the group disappears with
  // its last member
  await expect(dashGroup(page, "Releases")).toHaveCount(0);
  const moved = page.getByRole("button", { name: "Label Health", exact: true });
  await expect(moved).toBeVisible();
  await moved.click();
  await expect(page.locator(".dash-title")).toHaveText("Label Health");
});

test("the OPEN dashboard follows its file through a move (SUB-624)", async ({ page }) => {
  // moveNote retargeted `selected`/`dbNote`/`renaming` but not `view`, so an
  // open dashboard's pane lost its meta on the old path and fell back to the
  // list — easy to hit made moving a dashboard a normal gesture
  const row = page.getByRole("button", { name: "Label Health", exact: true });
  await row.click();
  await expect(page.locator(".dash-title")).toHaveText("Label Health");

  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to folder…" }).click();
  await page.locator(".ctx-item").filter({ hasText: /^Dashboards$/ }).click();

  // the pane survived the move — no fallback to a list view
  await expect(page.locator(".dash-title")).toHaveText("Label Health");
  await expect(page.locator(".list-title")).toHaveCount(0);

  // …and the view points at the NEW path: the moved row (now flat, its group
  // gone with its last member) is the one marked current
  await expect(dashGroup(page, "Releases")).toHaveCount(0);
  const moved = page.getByRole("button", { name: "Label Health", exact: true });
  await expect(moved).toHaveCount(1);
  await expect(moved).toHaveAttribute("aria-current", "page");
});

test("the OPEN dashboard follows its file through a rename (SUB-624)", async ({ page }) => {
  // the same hole on the sibling lane: a rename moves the file too (title →
  // stem), and onRenamed retargeted everything but `view`
  const row = page.getByRole("button", { name: "Overview", exact: true });
  await row.click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");

  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename" }).click();
  await page.locator(".side-item input").fill("Overview Two");
  await page.keyboard.press("Enter");

  await expect(page.locator(".dash-title")).toHaveText("Overview Two");
  await expect(page.locator(".list-title")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Overview Two", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

/* ----- dashboards foldered in the main tree ----- */

/** A folder tree row by name (the Folders section's rows, not a dash group). */
function treeFolder(page: Page, name: string) {
  return page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: new RegExp(`^${name}$`) }),
  });
}

/** The dashboard rows the FOLDER TREE owns, in render order. */
async function treeDashNames(page: Page): Promise<string[]> {
  return page.locator(".side-dash-nested .side-label-text").allTextContents();
}

test("a dashboard in a content folder renders under that folder's tree row", async ({ page }) => {
  // seed: Ideas/Sketch Metrics.md — a `type: dashboard` note outside the
  // dashboards home, so the Ideas tree row owns its row, not the section
  const row = page.getByRole("button", { name: "Sketch Metrics", exact: true });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();

  // it sits INSIDE the Folders tree: directly after the Ideas row, indented one
  // level past it, and gone when Ideas collapses
  const ideas = treeFolder(page, "Ideas");
  await expect(ideas).toHaveCount(1);
  const ideasBox = await ideas.boundingBox();
  const rowBox = await row.boundingBox();
  expect(rowBox!.y).toBeGreaterThan(ideasBox!.y);
  expect(rowBox!.x).toBeGreaterThan(ideasBox!.x - 1);

  // exactly one row, and it is the TREE's (no dual render — the split routes
  // each path to exactly one surface, so the section never renders it too)
  expect(await treeDashNames(page)).toEqual(["Sketch Metrics"]);

  // clicking it opens the dashboard pane
  await row.click();
  await expect(page.locator(".dash-title")).toHaveText("Sketch Metrics");

  // the Ideas chevron owns it: collapsing the folder hides the dashboard row
  await ideas.getByRole("button", { name: "Collapse Ideas" }).click();
  await expect(page.getByRole("button", { name: "Sketch Metrics", exact: true })).toHaveCount(0);
  await ideas.getByRole("button", { name: "Expand Ideas" }).click();
  await expect(page.getByRole("button", { name: "Sketch Metrics", exact: true })).toBeVisible();
});

test("dragging a Dashboards-section row onto a folder moves it into the tree", async ({ page }) => {
  // Overview lives in the dashboards home, so it starts as a SECTION row
  expect(await treeDashNames(page)).toEqual(["Sketch Metrics"]);

  // dispatch with an explicit DataTransfer (Chromium's synthetic-mouse drag
  // slips the source row — see folderorder.spec.ts)
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const overview = page.getByRole("button", { name: "Overview", exact: true });
  const ideas = treeFolder(page, "Ideas");
  await overview.dispatchEvent("dragstart", { dataTransfer });
  await ideas.dispatchEvent("dragover", { dataTransfer });
  await ideas.dispatchEvent("drop", { dataTransfer });

  // the file moved: still exactly one row, now owned by the tree instead of
  // the Dashboards section
  const moved = page.getByRole("button", { name: "Overview", exact: true });
  await expect(moved).toHaveCount(1);
  await expect(page.locator(".side-dash-nested .side-label-text")).toHaveText([
    "Overview",
    "Sketch Metrics",
  ]);
  const ideasBox = await ideas.boundingBox();
  const movedBox = await moved.boundingBox();
  expect(movedBox!.y).toBeGreaterThan(ideasBox!.y);

  // …and it still opens as a dashboard from its new home
  await moved.click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");

  // no pin was created by the gesture
  await expect(page.locator(".side-section-toggle", { hasText: "Pinned" })).toHaveCount(0);
});

test("dragging a tree dashboard onto the Dashboards header moves it home", async ({ page }) => {
  const row = page.getByRole("button", { name: "Sketch Metrics", exact: true });
  await expect(row).toBeVisible();
  const header = page.locator(".side-label-row", { hasText: "Dashboards" });

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer });
  await header.dispatchEvent("dragover", { dataTransfer });
  await header.dispatchEvent("drop", { dataTransfer });

  // it left the tree for the Dashboards section — one row throughout
  await expect(page.getByRole("button", { name: "Sketch Metrics", exact: true })).toHaveCount(1);
  await expect(page.locator(".side-dash-nested")).toHaveCount(0);
  await page.getByRole("button", { name: "Sketch Metrics", exact: true }).click();
  await expect(page.locator(".dash-title")).toHaveText("Sketch Metrics");
  // the gesture is a move, not a pin
  await expect(page.locator(".side-section-toggle", { hasText: "Pinned" })).toHaveCount(0);
});

test("the Dashboards header refuses a database drag (SUB-605 review)", async ({ page }) => {
  // the header takes NOTE drags only. It used to spread the shared folder drop
  // props, which also accept a database from the All-databases manager — that
  // silently homed the db on the hidden Dashboards/ folder, where it has no
  // tree row to render on at all.
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const releaseRow = page.locator(".dbmgr-row", { hasText: "Release" });
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries");

  await releaseRow.dragTo(page.locator(".side-label-row", { hasText: "Dashboards" }));

  // no home was set: the manager sub keeps its bare entry count, no toast, and
  // the database is still reachable only through the manager
  await expect(releaseRow.locator(".dbmgr-row-sub")).toHaveText("5 entries");
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("a section row moves past an interleaved tree row (SUB-605 review)", async ({ page }) => {
  // the section's Move lane must be the rows the section RENDERS, not the whole
  // persisted list. The seeded tree dashboard "Sketch Metrics" (Ideas/) sorts
  // between the section rows "Portfolio" and "Sync", so it sits interleaved in
  // that list on boot: Move DOWN on Portfolio used to swap it against the tree
  // row — an id the section never draws — and nothing moved on screen.
  const sectionOrder = async () => {
    const texts = await page
      .locator(".side-item:not(.side-dash-nested) .side-label-text")
      .allTextContents();
    return texts.filter((t) => ["Overview", "Portfolio", "Sync"].includes(t));
  };
  expect(await sectionOrder()).toEqual(["Overview", "Portfolio", "Sync"]);

  // the Move below swaps Portfolio with its on-screen NEIGHBOR, so the fixture
  // needs the two section rows adjacent: a seed whose title sorts between them
  // turns the swap into a hop past the newcomer, and the order this spec
  // filters for reads unchanged — a mysterious no-op. Fail loudly here instead.
  const flat = await page
    .locator(".side-item:not(.side-dash-nested) .side-label-text")
    .allTextContents();
  expect(
    flat.indexOf("Sync"),
    "fixture drift: a seeded dashboard title sorts between Portfolio and Sync"
  ).toBe(flat.indexOf("Portfolio") + 1);

  await page.getByRole("button", { name: "Portfolio", exact: true }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move down" }).click();
  expect(await sectionOrder()).toEqual(["Overview", "Sync", "Portfolio"]);

  // the tree row kept its own place through the section's reorder — the shared
  // persisted list didn't drop or shuffle it
  await expect(page.locator(".side-dash-nested .side-label-text")).toHaveText(["Sketch Metrics"]);
});

test("a tree dashboard reorders within its folder, by menu", async ({ page }) => {
  // give Ideas a second dashboard by dragging Overview in, then reorder the
  // pair — the lane is the folder's own, so the Dashboards section is untouched
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const ideas = treeFolder(page, "Ideas");
  await page.getByRole("button", { name: "Overview", exact: true }).dispatchEvent("dragstart", {
    dataTransfer,
  });
  await ideas.dispatchEvent("dragover", { dataTransfer });
  await ideas.dispatchEvent("drop", { dataTransfer });

  // both are Ideas' now, in the title order App sorts dashboards by
  await expect(page.locator(".side-dash-nested .side-label-text")).toHaveText([
    "Overview",
    "Sketch Metrics",
  ]);

  // the row's menu carries the Move lane for its OWN folder group
  await page.getByRole("button", { name: "Sketch Metrics", exact: true }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move up" }).click();
  await expect(page.locator(".side-dash-nested .side-label-text")).toHaveText([
    "Sketch Metrics",
    "Overview",
  ]);

  // the now-first row's Move up is disabled — the lane really is just this
  // folder's two rows, not every dashboard in the vault
  await page.getByRole("button", { name: "Sketch Metrics", exact: true }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveClass(/disabled/);
  await page.keyboard.press("Escape");

  // …and the Dashboards section's own rows kept their order through it
  await expect(page.locator(".side-item", { hasText: "Umbra Home" })).toBeVisible();
});

/* ----- the group header is a first-class row ----- */

/** A group header ONLY — `dashGroup` above also matches the tree row a group
    grows once it is moved out of the Dashboards section. */
function groupHeader(page: Page, name: string) {
  return page.locator(".side-dash-group", {
    has: page.locator(".side-label-text", { hasText: new RegExp(`^${name}$`) }),
  });
}

/** A dashboard's SIDEBAR row — the open note's title button carries the same
    accessible name, so an unscoped lookup double-counts once one is open. */
function sideDash(page: Page, name: string) {
  return page.locator(".sidebar-scroll").getByRole("button", { name, exact: true });
}

/** The Dashboards section's group header labels, in render order. */
async function groupNames(page: Page): Promise<string[]> {
  return page.locator(".side-dash-group .side-label-text").allTextContents();
}

/** Give the section a SECOND group: a new subfolder of the dashboards home,
    with a flat dashboard moved into it. The seed ships only "Releases". */
async function seedSecondGroup(page: Page) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New folder" }).click();
  const input = page.locator('.side-folder input[placeholder="Folder name"]');
  await input.fill("Dashboards/Metrics");
  await input.press("Enter");

  await page.getByRole("button", { name: "Overview", exact: true }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to folder…" }).click();
  await page.locator(".ctx-item").filter({ hasText: /^Dashboards\/Metrics$/ }).click();
  await expect(dashGroup(page, "Metrics")).toHaveCount(1);
}

test("a group header carries the folder menu; Rename keeps place and collapse", async ({
  page,
}) => {
  await seedSecondGroup(page);
  // the new group lands after the seeded one (the dashboards lane orders
  // the members; the headers follow that until the dashgroups lane says else)
  expect(await groupNames(page)).toEqual(["Releases", "Metrics"]);

  // collapse Releases first — the state has to survive the rename below
  const group = groupHeader(page, "Releases");
  await group.getByRole("button", { name: "Collapse Releases" }).click();
  await expect(sideDash(page, "Label Health")).toHaveCount(0);

  // right-click the header: the full folder menu, not the nothing a group
  // header used to answer a right-click with
  await group.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Rename…" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "New subfolder…" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Move to Trash" })).toBeVisible();
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();

  // the header renames inline, the same edit a tree folder row takes
  const input = page.locator(".side-dash-group input");
  await expect(input).toBeVisible();
  await input.fill("Drops");
  await input.press("Enter");

  // the label followed the folder on disk, and the group kept BOTH its slot in
  // the section and its collapsed state (the `dashgroup:` id was retargeted,
  // not orphaned into a fresh expanded group)
  await expect(groupHeader(page, "Releases")).toHaveCount(0);
  const renamed = groupHeader(page, "Drops");
  await expect(renamed).toHaveCount(1);
  expect(await groupNames(page)).toEqual(["Drops", "Metrics"]);
  await expect(sideDash(page, "Label Health")).toHaveCount(0);
  await renamed.getByRole("button", { name: "Expand Drops" }).click();
  await expect(sideDash(page, "Label Health")).toHaveCount(1);
});

test("Move to Trash on a group takes its dashboards; restore brings them back", async ({
  page,
}) => {
  await groupHeader(page, "Releases").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();

  // the group and its dashboard left the sidebar together
  await expect(groupHeader(page, "Releases")).toHaveCount(0);
  await expect(sideDash(page, "Label Health")).toHaveCount(0);

  // …and land in the Trash pane as ONE folder entry holding the note
  await page.locator(".side-item", { hasText: "Trash" }).click();
  const entry = page.locator(".trash-row", { hasText: "Releases" });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("1 note");
  await entry.locator(".trash-restore").click();

  // restore rebuilds the group header with its dashboard inside (the member
  // row below is the proof — headers carry no count since the sidebar
  // clarity pass)
  const back = groupHeader(page, "Releases");
  await expect(back).toHaveCount(1);
  const dash = sideDash(page, "Label Health");
  await expect(dash).toHaveCount(1);
  await dash.click();
  await expect(page.locator(".dash-title")).toHaveText("Label Health");
});

test("dragging a group header past another reorders the groups", async ({ page }) => {
  await seedSecondGroup(page);
  expect(await groupNames(page)).toEqual(["Releases", "Metrics"]);

  // dispatch with an explicit DataTransfer (Chromium's synthetic-mouse drag
  // slips the source row — see folderorder.spec.ts). The header carries BOTH
  // payloads; inside the dashgroups lane the reorder one wins, so this must
  // not nest Releases inside Metrics.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await groupHeader(page, "Metrics").dispatchEvent("dragstart", { dataTransfer });
  const releases = groupHeader(page, "Releases");
  await releases.dispatchEvent("dragover", { dataTransfer });
  await releases.dispatchEvent("drop", { dataTransfer });

  // dropped in the target's upper half (a dispatched event has clientY 0) →
  // Metrics lands before it
  expect(await groupNames(page)).toEqual(["Metrics", "Releases"]);

  // both are still their own top-level groups holding their own dashboard —
  // neither folder was moved into the other (the counts left the headers,
  // so the member rows themselves are the proof)
  await expect(groupHeader(page, "Releases")).toHaveCount(1);
  await expect(groupHeader(page, "Metrics")).toHaveCount(1);
  await expect(sideDash(page, "Label Health")).toHaveCount(1);
  await expect(sideDash(page, "Overview")).toHaveCount(1);

  // the new order is the one the lane PERSISTED: the menu's Move up reads the
  // same list back rather than restarting from alphabetical
  await groupHeader(page, "Releases").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move up" }).click();
  expect(await groupNames(page)).toEqual(["Releases", "Metrics"]);
});

test("dragging a group header onto a folder row moves the folder into the tree", async ({
  page,
}) => {
  expect(await treeDashNames(page)).toEqual(["Sketch Metrics"]);

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const ideas = treeFolder(page, "Ideas");
  await groupHeader(page, "Releases").dispatchEvent("dragstart", { dataTransfer });
  await ideas.dispatchEvent("dragover", { dataTransfer });
  await ideas.dispatchEvent("drop", { dataTransfer });

  // the whole subfolder moved: gone from the Dashboards section, a real tree
  // row under Ideas now, and its dashboard renders as one of the tree's
  // rather than a section row
  await expect(groupHeader(page, "Releases")).toHaveCount(0);
  const moved = treeFolder(page, "Releases");
  await expect(moved).toHaveCount(1);
  const ideasBox = await ideas.locator(".side-label-text").boundingBox();
  const movedBox = await moved.locator(".side-label-text").boundingBox();
  expect(movedBox!.y).toBeGreaterThan(ideasBox!.y);
  // …and INSIDE it: one indent level deeper than the row it was dropped on
  expect(movedBox!.x).toBeGreaterThan(ideasBox!.x);
  expect(await treeDashNames(page)).toEqual(["Label Health", "Sketch Metrics"]);

  // …and it still opens as a dashboard from its new home
  const dash = sideDash(page, "Label Health");
  await expect(dash).toHaveCount(1);
  await dash.click();
  await expect(page.locator(".dash-title")).toHaveText("Label Health");
  // the gesture is a move, not a pin
  await expect(page.locator(".side-section-toggle", { hasText: "Pinned" })).toHaveCount(0);
});

test("a moved group keeps its dashboards' manual order (SUB-698 review)", async ({ page }) => {
  // the `dashboards` lane holds full NOTE paths, so a moved group folder left
  // every entry inside it naming a dead path — applyOrder drops what it can't
  // match, and the group's hand-made order silently collapsed back to the
  // title sort. Needs TWO dashboards in the group to be visible at all.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const group = groupHeader(page, "Releases");
  await page.getByRole("button", { name: "Overview", exact: true }).dispatchEvent("dragstart", {
    dataTransfer,
  });
  await group.dispatchEvent("dragover", { dataTransfer });
  await group.dispatchEvent("drop", { dataTransfer });
  // the drop moved Overview into the group (headers lost their count in
  // The nested row is the evidence)
  const groupDashNames = () =>
    page.locator(".side-dash-group ~ .side-item .side-label-text").allTextContents();
  await expect
    .poll(async () => (await groupDashNames()).length, { timeout: 5000 })
    .toBe(2);

  // give the pair a deliberately NON-alphabetical persisted order
  await sideDash(page, "Overview").click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move up" }).click();
  expect(await groupDashNames()).toEqual(["Overview", "Label Health"]);

  // now move the whole group into the tree
  const move = await page.evaluateHandle(() => new DataTransfer());
  const ideas = treeFolder(page, "Ideas");
  await group.dispatchEvent("dragstart", { dataTransfer: move });
  await ideas.dispatchEvent("dragover", { dataTransfer: move });
  await ideas.dispatchEvent("drop", { dataTransfer: move });
  await expect(groupHeader(page, "Releases")).toHaveCount(0);

  // the pair rides along in the order the user made — not re-sorted by title,
  // which is what a dropped lane entry would have fallen back to
  expect(await treeDashNames(page)).toEqual(["Overview", "Label Health", "Sketch Metrics"]);
});

test("the OPEN dashboard inside a moved group follows the folder (SUB-624)", async ({ page }) => {
  // moveFolder followed only `view.kind === 'folder'`, so a dashboard open out
  // of the group was left on a dead path and the pane fell back to the list
  await sideDash(page, "Label Health").click();
  await expect(page.locator(".dash-title")).toHaveText("Label Health");

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const ideas = treeFolder(page, "Ideas");
  await groupHeader(page, "Releases").dispatchEvent("dragstart", { dataTransfer });
  await ideas.dispatchEvent("dragover", { dataTransfer });
  await ideas.dispatchEvent("drop", { dataTransfer });

  // the pane survived, and the row it points at is the one on the NEW path
  await expect(page.locator(".dash-title")).toHaveText("Label Health");
  await expect(page.locator(".list-title")).toHaveCount(0);
  const moved = sideDash(page, "Label Health");
  await expect(moved).toHaveCount(1);
  await expect(moved).toHaveAttribute("aria-current", "page");
});

test("a group header takes a key chip alongside its two drags (SUB-698 review)", async ({
  page,
}) => {
  // the header composes reorder + folder-move + (now) the key lane, dispatching
  // on the drag's MIME — the same three-way row a root folder is
  await page.keyboard.press("Meta+/");
  await page.locator(".sheet-assign-btn").click();
  await expect(page.locator(".key-hud")).toBeVisible();

  const group = groupHeader(page, "Releases");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const chip = page.locator(".key-hud-grid .key-chip").first();
  await expect(chip).toHaveText("⌘5");
  await chip.dispatchEvent("dragstart", { dataTransfer });
  await group.dispatchEvent("dragover", { dataTransfer });
  await group.dispatchEvent("drop", { dataTransfer });

  // the header wears the chip from now on, and the key opens the group folder
  await expect(group.locator(".side-key-chip")).toHaveText("⌘5");
  await page.keyboard.press("Escape");
  await page.locator(".side-item", { hasText: "All notes" }).first().click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".list-title")).toHaveText("Releases");
});
