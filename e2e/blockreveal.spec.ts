import { expect, test } from "@playwright/test";

// SUB-463: the table/view block-widget fields no longer recompute on every
// transaction, and the callout scan is scoped to the viewport. What must
// survive: a cursor entering a rendered block still reveals its source, a
// cursor leaving it still re-renders, and a callout still decorates after
// scrolling brings it into view.

test("cursor into a rendered table reveals source, cursor out re-renders", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  const table = page.locator(".cm-md-table");
  await expect(table).toBeVisible();

  // click into the prose above the table — a cursor move that touches no
  // block: the table must stay rendered (this is the skipped-recompute path)
  await page.locator(".cm-content").getByText("The basics").click();
  await expect(table).toBeVisible();

  // now put the cursor on the table's own line — source reveals as raw mono
  await page.locator(".cm-content").getByText("in review").click();
  await expect(table).toHaveCount(0);
  await expect(page.locator(".cm-table-line").first()).toBeVisible();

  // and leaving it re-renders the widget
  await page.locator(".cm-content").getByText("The basics").click();
  await expect(table).toBeVisible();
  await expect(page.locator(".cm-table-line")).toHaveCount(0);
});

// The view embed's own reveal-on-cursor path is not reachable by keyboard —
// a block widget swallows arrow keys, and that is true of main as well as this
// branch. What IS this branch's risk is the opposite: a cursor move elsewhere
// now skips the recompute, so the embed must neither vanish nor be rebuilt.
test("a rendered view embed survives cursor moves that touch no block", async ({ page }) => {
  await page.goto("/");
  // Projects/Umbra.md is the ```view fence fixture — reach it through ⌘K
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Umbra");
  await page
    .locator(".palette-item", { has: page.locator(".palette-item-label", { hasText: /^Umbra$/ }) })
    .first()
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");

  const embed = page.locator(".embed-view");
  await expect(embed).toBeVisible();

  // the embed renders its live rows from the release database
  await expect(embed).toContainText("Vessel Songs");

  // cursor above the fence, then below it, then back — the widget's DOM must
  // survive untouched (a rebuild would re-run the query and re-mount rows)
  await page.locator(".cm-content").getByText("Label hub for the Umbra").click();
  await expect(embed).toBeVisible();
  await page.locator(".cm-content").getByText("Rows open their note").click();
  await expect(embed).toBeVisible();
  await page.locator(".cm-content").getByText("Label hub for the Umbra").click();
  await expect(embed).toBeVisible();
  await expect(embed).toContainText("Vessel Songs");
  await expect(page.locator(".cm-content")).not.toContainText("status:mastering");
});

test("a callout scrolled out and back stays decorated", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");
  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra Home");

  const callouts = page.locator(".cm-callout-line");
  await expect(callouts.first()).toBeVisible();
  const before = await callouts.count();

  // scroll past them to the bottom, then back: a callout the viewport lost
  // and regained must be decorated again (the viewport-scoped scan rebuilds
  // on viewportChanged). Asserting on the bottom of the note would only
  // hold while the fixture fits one screen — it no longer does.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Meta+ArrowUp");
  await expect(page.locator(".cm-callout-line").first()).toBeVisible();
  expect(await page.locator(".cm-callout-line").count()).toBe(before);
  expect(before).toBeGreaterThan(0);
});

// The parse-advance regression (review finding): CM6 only parses ~3000 chars
// up front; a block past that window arrives via a background parse-advance
// transaction with no doc/selection/focus change. blockFieldUpdate must
// recompute on it (the syntaxTree reference compare) or the table renders as
// raw source forever.
test("a table beyond the initial parse window still renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toBeFocused();
  await page.keyboard.type("Deep table");
  await page.keyboard.press("Enter");

  // ~4000 chars of prose, then a table — typed as one clipboard insert so the
  // doc lands in a couple of transactions and the tail sits past the initial
  // parse window
  const filler = ("lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2000) + "\n\n").trim();
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  await page.locator(".cm-content").click();
  await page.keyboard.insertText(`${filler}\n\n${table}\n\nafter the table\n`);

  // cursor sits at the doc end after the insert — on the line below the
  // table, outside its region, with the table in the viewport. The assertion:
  // the widget must appear even though its region was parsed only by the
  // background parse advance (Meta+ArrowUp would defeat the test — CM6 only
  // materializes viewport DOM, and doc start is ~114KB away).
  await expect(page.locator(".cm-md-table")).toBeVisible({ timeout: 10_000 });
});
