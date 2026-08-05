import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// checkbox property kind: a schema'd checkbox prop renders a small
// check square in every row of its column; one click toggles and saves
// immediately (checked = YAML `true`, unchecked = prop removed, never
// `false`) — no editor popup. Fixtures: the inventory schema carries `in use`
// and every third gear row is true — Aeon Driftbox, Monocord 64, Klarheit
// K-2, Rothe R-8, Kern K-500 (src/lib/tauri.ts); the other ten rows demo the
// unchecked lane.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Inventory");
});

test("checkbox column renders a check square per row, checked filled, unchecked empty (SUB-173)", async ({ page }) => {
  // 15 gear rows: 5 checked squares, 10 unchecked
  await expect(page.locator(".db-cell .prop-check")).toHaveCount(15);
  await expect(page.locator(".db-cell .prop-check.on")).toHaveCount(5);

  // an unchecked cell renders blank — no "false", no placeholder text
  const row = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  await expect(row.locator(".prop-check")).toHaveCount(1);
  await expect(row.locator(".prop-check.on")).toHaveCount(0);
  await expect(row.locator(".db-cell-txt.cell-check")).toHaveText("");
});

test("clicking a checkbox cell toggles and persists across navigation (SUB-173)", async ({ page }) => {
  // check an unchecked row: whole cell is the affordance, no editor opens
  const uncheckedRow = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Nordvik One" }) });
  await uncheckedRow.locator(".prop-check").click();
  await expect(page.locator(".db-cell .prop-check.on")).toHaveCount(6);
  await expect(page.locator(".selmenu")).toHaveCount(0);

  // uncheck a checked row
  const checkedRow = page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Monocord 64" }) });
  await checkedRow.locator(".prop-check.on").click();
  await expect(page.locator(".db-cell .prop-check.on")).toHaveCount(5);

  // re-navigate: both toggles persisted through the mock backend
  await openDb(page, "Contact");
  await openDb(page, "Inventory");
  await expect(page.locator(".db-cell .prop-check.on")).toHaveCount(5);
  await expect(uncheckedRow.locator(".prop-check.on")).toHaveCount(1);
  await expect(checkedRow.locator(".prop-check.on")).toHaveCount(0);
});

test("checkbox note chip toggles and right-click opens schema options (SUB-173)", async ({ page }) => {
  await page.locator(".db-title-txt", { hasText: "Aeon Driftbox" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Aeon Driftbox");

  const chip = page.locator(".chip", { hasText: "in use" });
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".prop-check.on")).toHaveCount(1);

  // right-click opens the schema options, like other kinds
  await chip.click({ button: "right" });
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Checkbox");
  await menu.locator("button", { hasText: "Cancel" }).click();
  await expect(menu).toHaveCount(0);

  // click toggles off — the prop is removed (absent = unchecked), so the
  // chip goes with it; the state persists across re-opening the note
  await chip.click();
  await expect(page.locator(".chip", { hasText: "in use" })).toHaveCount(0);
  await openDb(page, "Inventory");
  await page.locator(".db-title-txt", { hasText: "Aeon Driftbox" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Aeon Driftbox");
  await expect(page.locator(".chip", { hasText: "in use" })).toHaveCount(0);
  await expect(
    page.locator("tr", { has: page.locator(".db-title-txt", { hasText: "Aeon Driftbox" }) }).locator(".prop-check.on")
  ).toHaveCount(0);
});
