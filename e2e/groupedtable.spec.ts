import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Grouped table view (SUB-184): section header rows partition one table by a
// select prop — schema option order, colored dots, muted counts, a trailing
// "No <prop>" section — against the deterministic mock backend (fresh page =
// fresh vault per test). The mock contact db is the "By Type" lane: four
// contacts, four schema'd role options in a deliberately non-alphabetical
// order (mix engineer, artwork, booking, radio plugger).

function groupRows(page: Page) {
  return page.locator(".db-group-tr");
}

function groupRow(page: Page, label: string) {
  return page.locator(".db-group-tr", {
    has: page.locator(".db-group-label", { hasText: label }),
  });
}

/** the data row immediately under a section header */
function rowUnder(page: Page, label: string) {
  return groupRow(page, label).locator("xpath=following-sibling::tr[1]");
}

async function openContacts(page: Page) {
  await page.goto("/");
  await openDb(page, "Contact");
}

/** pick a grouping column via the toolbar's SelectMenu */
async function groupTableBy(page: Page, col: string) {
  await page.locator(".db-group-btn").click();
  await page.locator(".selmenu-item", { hasText: col }).click();
}

/** ungroup via the same menu's clear row */
async function ungroupTable(page: Page) {
  await page.locator(".db-group-btn").click();
  await page.locator(".selmenu-item", { hasText: "Clear value" }).click();
}

test("group by a select prop: schema-order sections with counts, No-role section, ungroup restores", async ({
  page,
}) => {
  await openContacts(page);
  // ungrouped by default: four flat rows, no section headers
  await expect(groupRows(page)).toHaveCount(0);
  await expect(page.locator(".db-table tbody tr")).toHaveCount(4);

  // the grouping affordance mirrors the board's header control
  const picker = page.locator(".db-group-btn");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveText("None");

  await groupTableBy(page, "role");

  // one section per option holding rows, in SCHEMA order — not alphabetical
  // (that would be artwork, booking, mix engineer, radio plugger)
  await expect(groupRows(page)).toHaveCount(4);
  await expect(page.locator(".db-group-tr .db-group-label")).toHaveText([
    "mix engineer",
    "artwork",
    "booking",
    "radio plugger",
  ]);
  await expect(page.locator(".db-group-tr .db-group-count")).toHaveText(["1", "1", "1", "1"]);
  // the colored option dot rides the label, like the board's column headers
  await expect(groupRow(page, "mix engineer").locator(".opt-dot")).toBeVisible();

  // each section partitions its own rows
  await expect(rowUnder(page, "mix engineer")).toContainText("Gero");
  await expect(rowUnder(page, "artwork")).toContainText("Noa");
  await expect(rowUnder(page, "booking")).toContainText("Tess Almeida");
  await expect(rowUnder(page, "radio plugger")).toContainText("Annelies Verbeek");

  // a contact with no role gathers under a trailing "No role" section
  await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  await draft.fill("Sofia Lane");
  await draft.press("Enter");
  await expect(groupRows(page)).toHaveCount(5);
  await expect(groupRows(page).last()).toContainText("No role");
  await expect(groupRow(page, "No role").locator(".db-group-count")).toHaveText("1");
  await expect(rowUnder(page, "No role")).toContainText("Sofia Lane");

  // ungrouping restores the plain table: no headers, all five rows flat
  await ungroupTable(page);
  await expect(groupRows(page)).toHaveCount(0);
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);
});

test("empty sections don't render; keyboard nav glides over section headers", async ({ page }) => {
  await openContacts(page);
  await groupTableBy(page, "role");
  await expect(groupRows(page)).toHaveCount(4);

  // sort by the role column: one section per option still, order follows the
  // schema, not the sort — the sort orders rows WITHIN a section
  await page.locator(".db-th-label", { hasText: "role" }).click();
  await expect(page.locator(".db-group-tr .db-group-label")).toHaveText([
    "mix engineer",
    "artwork",
    "booking",
    "radio plugger",
  ]);

  // arrow keys move focus data row to data row — section headers are not
  // focusable cells (defocus the menu's input first by clicking the title)
  await page.locator(".list-title").click();
  await page.keyboard.press("ArrowDown");
  const focused = page.locator(".db-cell.focused");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute("data-fr", "0");
  // the next data row sits BELOW the second section header — focus lands on
  // it directly, proving the header row was skipped
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".db-cell.focused")).toHaveAttribute("data-fr", "1");
  await expect(rowUnder(page, "artwork").locator(".db-cell.focused")).toHaveCount(1);
});

test("a saved view captures the grouping", async ({ page }) => {
  await openContacts(page);
  await groupTableBy(page, "role");
  await expect(groupRows(page)).toHaveCount(4);

  // pin the grouped table via the view-actions menu
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("By role");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "By role" })).toHaveCount(1);

  // ungroup the database's own table, then open the pin — the saved
  // grouping comes back with it
  await ungroupTable(page);
  await expect(groupRows(page)).toHaveCount(0);
  await page.locator(".side-view", { hasText: "By role" }).click();
  await expect(page.locator(".list-title")).toHaveText("Contact");
  await expect(page.locator(".db-tab.active")).toHaveText("By role⌘5");
  await expect(groupRows(page)).toHaveCount(4);
  await expect(page.locator(".db-group-tr .db-group-label").first()).toHaveText("mix engineer");
});

test("the board is untouched: it still leads with its own grouping", async ({ page }) => {
  await openContacts(page);
  // group the table, then switch to the board: board grouping is independent
  await groupTableBy(page, "role");
  await expect(groupRows(page)).toHaveCount(4);
  await page.locator(".db-switch button[title=\"Board\"]").click();
  await expect(page.locator(".db-board")).toBeVisible();
  // contacts carry roles but no status — the board's own default grouping
  // kicks in (first groupable column), no crash on the table's key
  await expect(page.locator(".db-col").first()).toBeVisible();
  // back to the table: the table's grouping survived the round-trip
  await page.locator(".db-switch button[title=\"Table\"]").click();
  await expect(groupRows(page)).toHaveCount(4);
});

test("SUB-561: grouping doesn't inflate the footer count or its sums", async ({ page }) => {
  // the release db carries a relation column, `contact`, and one release names
  // two contacts — so grouping by it puts that release in two sections. The
  // footer counts notes, not section memberships: the tally must not move.
  await page.goto("/");
  await openDb(page, "Release");

  await page.locator(".db-table th", { hasText: "tracks" }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Calculate…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: /^Sum$/ }).click();
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  await expect(page.locator('.db-agg-cell[data-col="tracks"] .db-agg-value')).toHaveText("42");

  await groupTableBy(page, "contact");
  // the two-contact release really is on screen twice — six data rows over
  // three sections — which is what per-item grouping is for (SUB-221)
  await expect(page.locator(".db-group-tr")).toHaveCount(3);
  await expect(page.locator(".db-table tbody tr:not(.db-group-tr)")).toHaveCount(6);
  // …and the footer still answers for five notes worth 42 tracks
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  await expect(page.locator('.db-agg-cell[data-col="tracks"] .db-agg-value')).toHaveText("42");

  await ungroupTable(page);
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  await expect(page.locator('.db-agg-cell[data-col="tracks"] .db-agg-value')).toHaveText("42");
});
