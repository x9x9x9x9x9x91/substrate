import { expect, test, type Locator, type Page } from "./fixtures";
import { openDb, openFilter } from "./nav";

// Assignable keybinds. The ? sheet's "Assign keys…" button opens a
// floating HUD of free key chips; dragging a chip onto a sidebar destination
// binds it, dragging it back to the HUD clears it, and the key then navigates.
//
// Chromium's synthetic-mouse drag start slips the source to the row under the
// pointer, so — like e2e/folderorder.spec.ts:50-58 — the drag is dispatched
// with a real DataTransfer and the app's own handlers do the work.

/** Open the sheet, click through to the HUD. */
async function openHud(page: Page): Promise<void> {
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-sheet")).toBeVisible();
  await page.locator(".sheet-assign-btn").click();
  // the sheet gets out of the way — the sidebar has to stay droppable
  await expect(page.locator(".shortcut-sheet")).toHaveCount(0);
  await expect(page.locator(".key-hud")).toBeVisible();
}

/** Drag `chip` onto `target` with a real DataTransfer. */
async function dragChip(page: Page, chip: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await chip.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

/** The HUD's first free chip (pool order: ⌘5 — the mock vault boots with no
    saved views, so nothing is shadowed and the open grid starts at the top). */
const freeChip = (page: Page) => page.locator(".key-hud-grid .key-chip").first();

/** Pin one filtered view on Release (filter the table, then Save view… from
    the view menu), so digits 5–9 have a pin behind them and the warning that
    fires when a pin shadows a chip has something to warn about. */
async function savePin(page: Page, name: string): Promise<void> {
  await openDb(page, "Release");
  await (await openFilter(page)).fill("status:live ");
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill(name);
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: name })).toHaveCount(1);
}

/** The pin row in the ? sheet, which only lists digits that reach a live pin. */
const pinRow = (page: Page) =>
  page.locator(".shortcut-row", { hasText: "Go to pinned view" });

const sideRow = (page: Page, label: string) =>
  page.locator(".side-item", { hasText: label }).first();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
});

test("the sheet's Your keys section is empty until something is assigned", async ({ page }) => {
  await page.keyboard.press("Meta+/");
  await expect(page.locator(".palette-section", { hasText: "Your keys" })).toBeVisible();
  await expect(page.locator(".shortcut-row-empty")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("drag a chip onto a sidebar row: the row wears it and the key navigates", async ({ page }) => {
  await openHud(page);
  const chip = freeChip(page);
  await expect(chip).toHaveText("⌘5");

  const calendar = sideRow(page, "Calendar");
  await dragChip(page, chip, calendar);

  // the chip lives on the row from now on — not just while the HUD is open
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");
  // …and it's gone from the HUD's free grid, listed as assigned instead
  await expect(page.locator(".key-hud-grid .key-chip", { hasText: "⌘5" })).toHaveCount(0);
  await expect(page.locator(".key-hud-row-label", { hasText: "Calendar" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".key-hud")).toHaveCount(0);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // the binding works: park somewhere else, then press it
  await sideRow(page, "All notes").click();
  await expect(page.locator(".side-item.active", { hasText: "All notes" })).toBeVisible();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: "Calendar" })).toBeVisible();
});

test("dragging an assigned chip to another row moves the binding", async ({ page }) => {
  await openHud(page);
  const calendar = sideRow(page, "Calendar");
  await dragChip(page, freeChip(page), calendar);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // now drag the row's own chip onto a different destination
  const notes = sideRow(page, "Notes").first();
  await dragChip(page, calendar.locator(".side-key-chip"), notes);
  await expect(calendar.locator(".side-key-chip")).toHaveCount(0);
  await expect(notes.locator(".side-key-chip")).toHaveText("⌘5");

  await page.keyboard.press("Escape");
  await sideRow(page, "All notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: /^Notes/ })).toBeVisible();
});

test("dropping a chip back on the HUD unassigns it", async ({ page }) => {
  await openHud(page);
  const calendar = sideRow(page, "Calendar");
  await dragChip(page, freeChip(page), calendar);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  await dragChip(page, calendar.locator(".side-key-chip"), page.locator(".key-hud"));
  await expect(calendar.locator(".side-key-chip")).toHaveCount(0);
  // back in the free grid, in pool order
  await expect(freeChip(page)).toHaveText("⌘5");

  // and the key no longer navigates
  await page.keyboard.press("Escape");
  await sideRow(page, "All notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: "All notes" })).toBeVisible();
});

test("a second key on the same target replaces the first (one key per row)", async ({ page }) => {
  await openHud(page);
  const calendar = sideRow(page, "Calendar");
  await dragChip(page, freeChip(page), calendar);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");

  // the next free chip is ⌘6 — dropping it on the same row steals the slot
  await dragChip(page, freeChip(page), calendar);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘6");
  await expect(page.locator(".key-hud-row")).toHaveCount(1);
  // ⌘5 came back to the pool
  await expect(freeChip(page)).toHaveText("⌘5");
});

// The rows above are single-purpose drop targets. Three sidebar rows compose
// key-drop with a drag they already had (Sidebar.tsx:446-497) and dispatch on
// the drag's MIME instead of spreading one handler set over the other — the
// spread would silently win. One test per composed row.

test("a root folder row takes a key alongside its reorder drag", async ({ page }) => {
  await openHud(page);
  // Projects is a root folder: reorder source AND note/db drop target AND now
  // a key target, all three on one row
  const projects = page.locator(".side-folder", { hasText: "Projects" }).first();
  await dragChip(page, freeChip(page), projects);
  await expect(projects.locator(".side-key-chip")).toHaveText("⌘5");

  await page.keyboard.press("Escape");
  await sideRow(page, "All notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-folder.active", { hasText: "Projects" })).toBeVisible();
});

test("a nested folder row takes a key (no reorder lane below root)", async ({ page }) => {
  await openHud(page);
  const active = page.locator(".side-folder", { hasText: "Active" }).first();
  await expect(active).toBeVisible();
  await dragChip(page, freeChip(page), active);
  await expect(active.locator(".side-key-chip")).toHaveText("⌘5");

  await page.keyboard.press("Escape");
  await sideRow(page, "All notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-folder.active", { hasText: "Active" })).toBeVisible();
});

test("a dashboard row takes a key alongside its reorder drag", async ({ page }) => {
  await openHud(page);
  const portfolio = sideRow(page, "Portfolio");
  await dragChip(page, freeChip(page), portfolio);
  await expect(portfolio.locator(".side-key-chip")).toHaveText("⌘5");

  await page.keyboard.press("Escape");
  await sideRow(page, "All notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: "Portfolio" })).toBeVisible();
});

// The engine keeps the stored TARGETS truthful — a key bound to something
// renamed follows it, a key bound to something deleted is freed. The mock
// backend mirrors those hooks, so the browser sees the same behaviour the Rust
// tests pin. `Tasks` is the mock vault's home-folder database row —
// It wears the FOLDER name with a DB chip and carries a `db:` target.
test("a key on a database row follows the rename and dies with the delete", async ({ page }) => {
  await openHud(page);
  const taskRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await dragChip(page, freeChip(page), taskRow);
  await expect(taskRow.locator(".side-key-chip")).toHaveText("⌘5");
  await page.keyboard.press("Escape");

  // rename the database: the row keeps its FOLDER name and the
  // key — the db: target underneath follows the rename
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Task" }).locator(".dbmgr-menu").click();
  await page.locator(".ctx-item", { hasText: "Rename database…" }).click();
  const rename = page.locator(".dbform");
  await rename.locator(".dbform-input").fill("errand");
  await rename.locator(".selmenu-btn-primary").click();

  await expect(taskRow.locator(".side-key-chip")).toHaveText("⌘5");
  // and it still navigates — to the renamed database
  await page.locator(".side-item", { hasText: "All notes" }).first().click();
  await page.keyboard.press("Meta+5");
  await expect(taskRow).toHaveClass(/active/);

  // delete it (keeping the notes still removes the database): the key comes back
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Errand" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete database…" }).click();
  await page.locator(".dbform").locator(".selmenu-btn", { hasText: "Remove database, keep" }).click();

  await openHud(page);
  await expect(freeChip(page)).toHaveText("⌘5");
  await expect(page.locator(".key-hud-row")).toHaveCount(0);
});

test("assigned keys show up in the cheat sheet's Your keys section", async ({ page }) => {
  await openHud(page);
  await dragChip(page, freeChip(page), sideRow(page, "Calendar"));
  await page.keyboard.press("Escape");
  await expect(page.locator(".key-hud")).toHaveCount(0);

  await page.keyboard.press("Meta+/");
  await expect(page.locator(".shortcut-row-empty")).toHaveCount(0);
  // the static ⌘4 view row also says "Calendar" — Your keys is the last
  // section, so take the last match
  const row = page.locator(".shortcut-row", { hasText: "Calendar" }).last();
  await expect(row.locator(".key")).toHaveText("⌘5");
  await page.keyboard.press("Escape");
});

// With pins live, digits 5–9 are already spoken for. The HUD used to
// offer them as unclaimed and the sheet listed the whole ⌘5…⌘9 run regardless,
// so a drop silently retired a working pin shortcut with nothing said.
test("the HUD lists pin-shadowing keys apart, still draggable", async ({ page }) => {
  // no pins yet: everything is plainly free, no second section
  await openHud(page);
  await expect(page.locator(".key-hud-section", { hasText: "Used by pinned views" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await savePin(page, "Live releases");
  await openHud(page);

  // ⌘5 and ⌃5 both sit on the first pin — `mod` in view-pins' combo means ⌘ OR ⌃
  const shadowed = page.locator(".key-chip-shadow");
  await expect(shadowed).toHaveText(["⌘5", "⌃5"]);
  // Each shadowing chip names the pin it would displace
  await expect(page.locator(".key-hud-row-label")).toHaveText(["Live releases", "Live releases"]);
  await expect(page.locator(".key-hud-hint", { hasText: "replaces its pin shortcut" })).toBeVisible();
  // ⌘6 has no second pin behind it, so it stays an ordinary free chip
  await expect(freeChip(page)).toHaveText("⌘6");

  // the drop still works — custom-key beating the pin mapping is the spec'd
  // precedence, so the section is a label, not a block
  const calendar = sideRow(page, "Calendar");
  await dragChip(page, shadowed.first(), calendar);
  await expect(calendar.locator(".side-key-chip")).toHaveText("⌘5");
  await page.keyboard.press("Escape");

  await sideRow(page, "All notes").click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".side-item.active", { hasText: "Calendar" })).toBeVisible();
});

test("the sheet's pin row shows only digits that reach a pin", async ({ page }) => {
  // no pins: the row has nothing to offer and doesn't render
  await page.keyboard.press("Meta+/");
  await expect(pinRow(page)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await savePin(page, "Live releases");
  await page.keyboard.press("Meta+/");
  await expect(pinRow(page).locator(".key")).toHaveText(["⌘5"]);
  await page.keyboard.press("Escape");

  // assigning ⌘5 retires that pin shortcut, so the row goes away with it and
  // the sheet stops naming one key for two destinations
  await openHud(page);
  await dragChip(page, page.locator(".key-chip-shadow").first(), sideRow(page, "Calendar"));
  await page.keyboard.press("Escape");
  await expect(page.locator(".key-hud")).toHaveCount(0);

  await page.keyboard.press("Meta+/");
  await expect(pinRow(page)).toHaveCount(0);
  await expect(page.locator(".shortcut-row", { hasText: "Calendar" }).last().locator(".key")).toHaveText("⌘5");
  await page.keyboard.press("Escape");
});
