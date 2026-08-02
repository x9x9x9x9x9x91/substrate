import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// rollup property kind (SUB-678): a derived column — follow a relation prop
// of the SAME database, fold a target prop over the linked rows, computed on
// read and stored nowhere. The issue's own example, end-to-end through the
// UI against the mock backend: a new database with a relation into the
// seeded royalty Ledger, entries staged with relation values through the
// mock's e2e prop hook (like a hand-edited vault), the rollup prop added
// through the table's ＋ add-property popover, and the rolled grosses
// asserted in cells and in the footer's Calculate.

/** sidebar ＋ → New database…, with one initial relation property */
async function newDatabaseWithRelation(page: Page, name: string, prop: string, target: string) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".dbform-input").first().fill(name);
  await form.locator(".dbform-addprop").click();
  const row = form.locator(".dbform-proprow").last();
  await row.locator(".dbform-input").fill(prop);
  // the kind/target pickers are SelectMenu buttons (SUB-647 swapped the
  // stock selects): click the row button, pick the option from the menu
  await row.locator(".dbform-select").first().click();
  await page.getByRole("option", { name: "Relation", exact: true }).click();
  await row.locator(".dbform-select").last().click();
  await page.getByRole("option", { name: target, exact: true }).click();
  await form.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText(name);
}

/** create one entry in the open database via the draft row */
async function newEntry(page: Page, title: string) {
  if ((await page.locator(".db-draft-input").count()) === 0) {
    const empty = page.locator(".empty-action");
    if ((await empty.count()) > 0) await empty.click();
    else await page.locator(".db-new").click();
  }
  const draft = page.locator(".db-draft-input");
  await draft.fill(title);
  await draft.press("Enter");
  await expect(
    page.locator(".db-title-txt", { hasText: new RegExp(`^${title}$`) })
  ).toHaveCount(1);
}

/** stage frontmatter values the way a hand-edited vault would carry them */
async function stageProps(page: Page, edits: [path: string, key: string, value: unknown][]) {
  await page.evaluate((batch) => {
    for (const [path, key, value] of batch) window.__mockEditProp!(path, key, value);
    window.__mockEmit!("vault:changed");
  }, edits);
}

const row = (page: Page, title: string) =>
  page.locator("tr", { has: page.locator(".db-title-txt", { hasText: new RegExp(`^${title}$`) }) });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await newDatabaseWithRelation(page, "Rollrel", "entries", "ledger");
  await newEntry(page, "RX1");
  await newEntry(page, "RX2");
  await newEntry(page, "RX3");
  // two ledger statements on RX1 (gross 4213.55 + 3550.10 = 7763.65), one on
  // RX2 (1186.42), none on RX3 — seeded rows from the SUB-193 ledger
  // fixture. The sidebar create flow homes the new database in its
  // eponymous folder, so the entries live under Rollrel/
  await stageProps(page, [
    ["Rollrel/RX1.md", "entries", ["Bandcamp 2026 Q2", "Bandcamp 2026 Q1"]],
    ["Rollrel/RX2.md", "entries", "Spotify 2026-05"],
  ]);
  // the rollup prop itself goes in through the ＋ add-property popover
  await page.locator(".db-add-btn").click();
  const form = page.locator(".selmenu");
  await form.locator(".dbprop-name").fill("earned");
  await form.locator(".selmenu-kind", { hasText: "Rollup" }).click();
  // the relation picker prefills the database's one relation prop
  await expect(form.getByRole("combobox", { name: "Relation to follow" })).toHaveValue("entries");
  await form
    .getByRole("listbox", { name: "Property to roll up" })
    .getByRole("option", { name: "gross" })
    .click();
  // Sum rides as the default function
  await expect(form.locator(".selmenu-kind.active", { hasText: "Sum" })).toHaveCount(1);
  await form.locator(".selmenu-btn-primary", { hasText: "Save" }).click();
  await expect(form).toHaveCount(0);
});

test("a rollup column folds the linked rows, stored nowhere (SUB-678)", async ({ page }) => {
  // de-DE rendered like the footer: 7.763,65 and 1.186,42; empty for the
  // entry with no relation value
  await expect(row(page, "RX1").locator(".cell-num")).toHaveText("7.763,65");
  await expect(row(page, "RX2").locator(".cell-num")).toHaveText("1.186,42");
  await expect(row(page, "RX3").locator(".cell-num")).toHaveText("");

  // derived means read-only: clicking the cell opens no editor
  await row(page, "RX1").locator(".cell-num").click();
  await expect(page.locator(".selmenu")).toHaveCount(0);

  // …and nothing ever landed in frontmatter — the value is computed on read
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "earned"), "Rollrel/RX1.md")).toBe(
    undefined
  );

  // the column itself footer-aggregates like any numeric column
  await page
    .locator("th", { has: page.locator(".db-th-label", { hasText: "Earned" }) })
    .locator(".db-th-caret")
    .click();
  await page.locator(".colmenu .dots-item", { hasText: "Calculate…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "Sum" }).click();
  const foot = page.locator('td.db-agg-cell[data-col="earned"]');
  await expect(foot.locator(".db-agg-kind")).toHaveText("Sum");
  await expect(foot.locator(".db-agg-value")).toHaveText("8.950,07");
});

test("rollup values re-derive on read (SUB-678)", async ({ page }) => {
  await openDb(page, "Ledger");
  await openDb(page, "Rollrel");
  await expect(row(page, "RX1").locator(".cell-num")).toHaveText("7.763,65");
  // a staged edit on a linked row re-folds on the next read
  await stageProps(page, [["Bandcamp 2026 Q2.md", "gross", "5000"]]);
  await expect(row(page, "RX1").locator(".cell-num")).toHaveText("8.550,1");
});
