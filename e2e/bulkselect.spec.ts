import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Table row multi-select + bulk bar against the mock backend's
// Contact db: four rows resting in title order (Annelies, Gero, Noa, Tess),
// `role` a schema'd select prop (mix engineer / artwork / booking / radio
// plugger). Fresh page = fresh vault per test.

async function openContacts(page: Page) {
  await page.goto("/");
  await openDb(page, "Contact");
}

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

function titleCell(page: Page, title: string) {
  return row(page, title).locator(".db-title");
}

test("⌘-click toggles rows into a selection; the bar counts them", async ({ page }) => {
  await openContacts(page);
  await titleCell(page, "Annelies").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("1 selected");
  await titleCell(page, "Noa").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("2 selected");
  await expect(page.locator("tr.is-selected")).toHaveCount(2);
  await expect(row(page, "Annelies")).toHaveClass(/is-selected/);
  await expect(row(page, "Noa")).toHaveClass(/is-selected/);
  // toggling a selected row removes it again
  await titleCell(page, "Annelies").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("1 selected");
  await expect(page.locator("tr.is-selected")).toHaveCount(1);
  await expect(row(page, "Annelies")).not.toHaveClass(/is-selected/);
});

test("shift-click ranges from the last plain-clicked row over flat rows indices", async ({ page }) => {
  await openContacts(page);
  // double-click: the note opens and the row becomes the anchor
  await titleCell(page, "Annelies").dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Annelies Verbeek");
  await titleCell(page, "Tess").click({ modifiers: ["Shift"] });
  await expect(page.locator(".bulkbar")).toContainText("4 selected");
  await expect(page.locator("tr.is-selected")).toHaveCount(4);
});

test("Escape clears the selection first; the table stays put", async ({ page }) => {
  await openContacts(page);
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await titleCell(page, "Noa").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".bulkbar")).toHaveCount(0);
  await expect(page.locator("tr.is-selected")).toHaveCount(0);
  await expect(page.locator(".db-table")).toBeVisible();
});

test("Set property… applies the committed value to every selected row", async ({ page }) => {
  await openContacts(page);
  await titleCell(page, "Annelies").click({ modifiers: ["Meta"] });
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  // the column picker lists the visible columns; role is select-kind
  await page.locator(".colmenu .dots-item", { hasText: "role" }).click();
  await page.locator(".selmenu-item", { hasText: "booking" }).click();
  await expect(row(page, "Annelies").locator(".db-cell", { hasText: "booking" })).toHaveCount(1);
  await expect(row(page, "Gero").locator(".db-cell", { hasText: "booking" })).toHaveCount(1);
  // the one-shot write consumed the selection
  await expect(page.locator(".bulkbar")).toHaveCount(0);
});

test("Move to Trash trashes every selected row with one summary toast; Undo restores all", async ({
  page,
}) => {
  await openContacts(page);
  await expect(page.locator(".db-table tbody tr")).toHaveCount(4);
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await titleCell(page, "Noa").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".bulkbar")).toHaveCount(0);
  const toast = page.locator(".toast");
  await expect(toast).toContainText("2 notes moved to Trash");
  await toast.locator("button", { hasText: "Undo" }).click();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(4);
  await expect(row(page, "Gero")).toHaveCount(1);
  await expect(row(page, "Noa")).toHaveCount(1);
});

// Engine::trash_list sorts `deleted_ms DESC, path ASC`, and the
// Trash pane renders that order as-is. A bulk trash puts several entries in
// the same millisecond, so the pane's order is decided purely by the path
// tie-break — the one place the engine's contract is directly observable.
// The mock used to list in insertion order, which reverses this.
//
// Timing premise (review-flagged): the two `vaultDelete` calls are
// microtask-adjacent, so their `Date.now()` stamps tie. If this spec ever
// fails "Noa first" the tie broke (a slow delete lane, `__mockSetAsync`),
// NOT the mock sort — the ordering under distinct stamps is legitimately
// newest-first.
test("a same-millisecond bulk trash lists in path order, newest group first (SUB-488)", async ({
  page,
}) => {
  await openContacts(page);
  // trash Gero first, then Noa, so insertion order (newest-first: Noa) and
  // the engine's path tie-break (Gero) disagree
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await titleCell(page, "Noa").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  await page.locator(".side-item", { hasText: "Trash" }).click();
  const titles = page.locator(".trash-row .trash-row-title");
  await expect(titles).toHaveCount(2);
  // Gero.md before Noa.md — path ASC within the same deleted_ms
  await expect(titles.nth(0)).toHaveText("Gero");
  await expect(titles.nth(1)).toHaveText("Noa");
});

// The sibling above passes only while the two deletes happen to land
// on the same millisecond. Under parallel-suite load one boundary fell between
// them and the group split across two `deleted_ms` values, putting Noa first.
// Stubbing Date.now to advance every reading forces that boundary on every
// run, without adding an await into the racing window. The bulk trash is now
// ONE vault_delete_many that stamps the whole selection once, so the group
// stays together and path order still decides.
test("a bulk trash survives a millisecond boundary mid-selection (SUB-577)", async ({ page }) => {
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    let bump = 0;
    Date.now = () => real() + bump++;
  });
  await openContacts(page);
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await titleCell(page, "Noa").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  await page.locator(".side-item", { hasText: "Trash" }).click();
  const titles = page.locator(".trash-row .trash-row-title");
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveText("Gero");
  await expect(titles.nth(1)).toHaveText("Noa");
});

test("a double-click with a selection active opens the note and clears the selection", async ({
  page,
}) => {
  await openContacts(page);
  await titleCell(page, "Annelies").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("1 selected");
  await titleCell(page, "Gero").dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Gero");
  await expect(page.locator(".bulkbar")).toHaveCount(0);
  await expect(page.locator("tr.is-selected")).toHaveCount(0);
});

// A bulk multi/relation edit REPLACES each selected note's whole
// list with the picked set — it is NOT additive, however the toggles read.
// The picker states the replace up front (one quiet line naming the column
// and the selection size) and every live write toasts, so the replace is
// never silent. Fixture: Release db — Slow Bloom EP (format Vinyl, contact
// Gero), Vessel Songs (format [Tape], no contact), Static Bouquet untouched.
test("bulk multi picker states the replace and toasts the write", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await titleCell(page, "Slow Bloom EP").click({ modifiers: ["Meta"] });
  await titleCell(page, "Vessel Songs").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "format" }).click();
  await expect(page.locator(".selmenu-bulknote")).toHaveText(
    "Replaces the Format of all 2 selected notes"
  );
  await page.locator(".selmenu-item", { hasText: "Digital" }).click();
  await expect(page.locator(".toast")).toContainText("Set Format on 2 notes");
  await page.keyboard.press("Escape");
  // both rows now hold exactly Digital — Vinyl and Tape are gone from them
  const slow = row(page, "Slow Bloom EP");
  await expect(slow.locator(".db-cell", { hasText: "Digital" })).toHaveCount(1);
  await expect(slow).not.toContainText("Vinyl");
  const vessel = row(page, "Vessel Songs");
  await expect(vessel.locator(".db-cell", { hasText: "Digital" })).toHaveCount(1);
  await expect(vessel).not.toContainText("Tape");
});

test("bulk relation picker states the replace and toasts the write", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await titleCell(page, "Slow Bloom EP").click({ modifiers: ["Meta"] });
  await titleCell(page, "Vessel Songs").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "contact" }).click();
  await expect(page.locator(".selmenu-bulknote")).toHaveText(
    "Replaces the Contact of all 2 selected notes"
  );
  await page.locator(".selmenu-item", { hasText: "Noa" }).click();
  await expect(page.locator(".toast")).toContainText("Set Contact on 2 notes");
  await page.keyboard.press("Escape");
  // Slow Bloom's Gero is gone — both rows now link Noa and nothing else
  const slow = row(page, "Slow Bloom EP");
  await expect(slow.locator(".db-cell", { hasText: "Noa" })).toHaveCount(1);
  await expect(slow).not.toContainText("Gero");
  await expect(row(page, "Vessel Songs").locator(".db-cell", { hasText: "Noa" })).toHaveCount(1);
});
