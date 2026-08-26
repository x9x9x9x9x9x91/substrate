import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Grouped-table sections as things you can HANDLE: fold one shut, move
// selected rows into one from the bulk bar, drag one into a different place —
// each persisted on the database's ViewPref (views.json in the real engine,
// mockViews here), so it survives navigating away and back. Against the
// deterministic mock backend's Contact db (fresh page = fresh vault per
// test): four contacts, four schema'd role options in a deliberately
// non-alphabetical order (mix engineer, artwork, booking, radio plugger).

function groupRow(page: Page, label: string) {
  return page.locator(".db-group-tr", {
    has: page.locator(".db-group-label", { hasText: label }),
  });
}

/** the data rows on screen — section headers and spacers are not rows */
function dataRows(page: Page) {
  return page.locator(".db-table tbody tr:not(.db-group-tr):not(.db-win-spacer)");
}

function row(page: Page, title: string) {
  return dataRows(page).filter({ hasText: title });
}

async function sectionOrder(page: Page): Promise<string[]> {
  const texts = await page.locator(".db-group-tr .db-group-label").allTextContents();
  return texts.map((t) => t.trim());
}

async function openContacts(page: Page) {
  await openDb(page, "Contact");
  await expect(page.locator(".db-table")).toBeVisible();
}

async function groupTableBy(page: Page, col: string) {
  await page.locator(".db-group-btn").click();
  await page.locator(".selmenu-item", { hasText: col }).click();
}

/** away to All notes and back — the round-trip through the persisted pref.
    All notes renders the list surface, not a table, so the departure is
    confirmed on the list title before reopening. */
async function reopenContacts(page: Page) {
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await openContacts(page);
}

// Chromium's synthetic-mouse drag never reaches the app's dragstart with a
// usable payload (see folderorder.spec.ts), so dispatch the events with a
// real DataTransfer — the app's own handlers still do all the work. A
// dispatched event has no clientY, i.e. y=0: above every header's midpoint,
// so a drop lands the dragged section BEFORE the target.
async function dragSectionBefore(page: Page, from: string, to: string) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await groupRow(page, from)
    .locator(".db-group-disclose")
    .dispatchEvent("dragstart", { dataTransfer });
  const target = groupRow(page, to);
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

test("fold a section shut: its rows go, its count stays, and it stays shut", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");
  await expect(dataRows(page)).toHaveCount(4);

  const mix = groupRow(page, "mix engineer");
  await mix.locator(".db-group-disclose").click();

  // the section's own row is gone; the other three sections are untouched
  await expect(dataRows(page)).toHaveCount(3);
  await expect(row(page, "Gero")).toHaveCount(0);
  await expect(mix).toHaveClass(/is-collapsed/);
  await expect(mix.locator(".db-group-disclose")).toHaveAttribute("aria-expanded", "false");
  // the header keeps answering for the whole section, folded or not
  await expect(mix.locator(".db-group-count")).toHaveText("1");
  // …and so does the footer: a fold is a view state, not a filter
  await expect(page.locator(".db-agg-title")).toHaveText("4 rows");

  // persists across a page switch (mock vault_views_set round-trip)
  await reopenContacts(page);
  await expect(groupRow(page, "mix engineer")).toHaveClass(/is-collapsed/);
  await expect(dataRows(page)).toHaveCount(3);

  // clicking again opens it back up, and that persists too
  await groupRow(page, "mix engineer").locator(".db-group-disclose").click();
  await expect(dataRows(page)).toHaveCount(4);
  await reopenContacts(page);
  await expect(groupRow(page, "mix engineer")).not.toHaveClass(/is-collapsed/);
  await expect(dataRows(page)).toHaveCount(4);
});

test("every section folded shut leaves the table standing, headers and all", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");
  for (const label of ["mix engineer", "artwork", "booking", "radio plugger"])
    await groupRow(page, label).locator(".db-group-disclose").click();
  await expect(dataRows(page)).toHaveCount(0);
  await expect(page.locator(".db-group-tr")).toHaveCount(4);
  await expect(page.locator(".db-agg-title")).toHaveText("4 rows");
  // no empty state took the table's place
  await expect(page.locator(".db-table")).toBeVisible();
});

test("Move to group… assigns the grouped prop to every selected row", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  // ungrouped, the bulk bar has no Move to group… — there is no group to move to
  await row(page, "Annelies").locator(".db-title").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar button", { hasText: "Move to group…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await groupTableBy(page, "role");
  await row(page, "Annelies").locator(".db-title").click({ modifiers: ["Meta"] });
  await row(page, "Gero").locator(".db-title").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("2 selected");

  // straight to the value picker — the column is the one the table groups by
  await page.locator(".bulkbar button", { hasText: "Move to group…" }).click();
  await page.locator(".selmenu-item", { hasText: "booking" }).click();

  // both rows landed in the booking section, which now answers for three
  await expect(groupRow(page, "booking").locator(".db-group-count")).toHaveText("3");
  await expect(page.locator(".db-group-tr")).toHaveCount(2);
  await expect(page.locator(".bulkbar")).toHaveCount(0);

  // one undo entry for the pair: both rows go back where they were
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".db-group-tr")).toHaveCount(4);
  await expect(groupRow(page, "booking").locator(".db-group-count")).toHaveText("1");
});

test("Move to group…: typing a new name creates the schema option and the section", async ({
  page,
}) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");
  await row(page, "Noa").locator(".db-title").click({ modifiers: ["Meta"] });

  await page.locator(".bulkbar button", { hasText: "Move to group…" }).click();
  await page.locator(".selmenu-input").fill("mastering");
  await page.locator(".selmenu-item", { hasText: "Add “mastering” to options" }).click();

  await expect(groupRow(page, "mastering")).toHaveCount(1);
  await expect(groupRow(page, "mastering").locator(".db-group-count")).toHaveText("1");
  await expect(groupRow(page, "artwork")).toHaveCount(0);

  // it is a real schema option now, not a stray value: it comes back in the
  // picker's option list without typing
  await row(page, "Tess").locator(".db-title").click({ modifiers: ["Meta"] });
  await page.locator(".bulkbar button", { hasText: "Move to group…" }).click();
  await expect(page.locator(".selmenu-item", { hasText: "mastering" })).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("drag a section header to reorder; the hand order persists", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");
  // schema order to start with — not alphabetical, and nothing a default
  // ordering would ever produce with the last option leading
  expect(await sectionOrder(page)).toEqual([
    "mix engineer",
    "artwork",
    "booking",
    "radio plugger",
  ]);

  await dragSectionBefore(page, "radio plugger", "mix engineer");
  const expected = ["radio plugger", "mix engineer", "artwork", "booking"];
  expect(await sectionOrder(page)).toEqual(expected);
  // rows follow their headers
  await expect(dataRows(page).first()).toContainText("Annelies");

  await reopenContacts(page);
  expect(await sectionOrder(page)).toEqual(expected);

  // regrouping by another column starts from that column's own order — the
  // role order is not carried onto a different partition
  await groupTableBy(page, "email");
  await page.locator(".db-group-btn").click();
  await page.locator(".selmenu-item", { hasText: "role" }).click();
  expect(await sectionOrder(page)).toEqual([
    "mix engineer",
    "artwork",
    "booking",
    "radio plugger",
  ]);
});

test("drag rows onto a section header to move them there", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "Gero").dispatchEvent("dragstart", { dataTransfer });
  const target = groupRow(page, "booking");
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });

  await expect(groupRow(page, "booking").locator(".db-group-count")).toHaveText("2");
  await expect(groupRow(page, "mix engineer")).toHaveCount(0);
  await expect(row(page, "Gero").locator(".db-cell", { hasText: "booking" })).toHaveCount(1);
});

/** a note drag with a payload this table never rendered — what the sidebar
    hands a section header when a note is dragged out of it */
async function foreignNoteDrag(page: Page) {
  return page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.setData("application/x-substrate-note", "Calendar/Some Foreign Note.md");
    return dt;
  });
}

test("a note dragged in from outside the table is not regrouped by it", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");
  const before = await sectionOrder(page);

  // no drag started in this table at all — the sidebar's gesture
  const outside = await foreignNoteDrag(page);
  let target = groupRow(page, "booking");
  await target.dispatchEvent("dragover", { dataTransfer: outside });
  await expect(target).not.toHaveClass(/note-drop/);
  await target.dispatchEvent("drop", { dataTransfer: outside });

  // and the same payload behind a real row drag: the gesture is this table's,
  // so the header takes the drop — and the pane still refuses a path it never
  // showed. (The row's own dragstart writes its path over the payload, so the
  // foreign one is put back after the handler has run.)
  const carried = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "Gero").dispatchEvent("dragstart", { dataTransfer: carried });
  await page.evaluate(
    (dt) => dt.setData("application/x-substrate-note", "Calendar/Some Foreign Note.md"),
    carried
  );
  target = groupRow(page, "booking");
  await target.dispatchEvent("dragover", { dataTransfer: carried });
  await target.dispatchEvent("drop", { dataTransfer: carried });

  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(groupRow(page, "booking").locator(".db-group-count")).toHaveText("1");
  await expect(dataRows(page)).toHaveCount(4);
  expect(await sectionOrder(page)).toEqual(before);
});

test("dropping rows on the section they are already in writes nothing", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "Tess").dispatchEvent("dragstart", { dataTransfer });
  const own = groupRow(page, "booking");
  await own.dispatchEvent("dragover", { dataTransfer });
  await own.dispatchEvent("drop", { dataTransfer });

  // no write, so no toast claiming a move and nothing for undo to take back
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(groupRow(page, "booking").locator(".db-group-count")).toHaveText("1");
  await page.keyboard.press("Meta+z");
  expect(await sectionOrder(page)).toEqual([
    "mix engineer",
    "artwork",
    "booking",
    "radio plugger",
  ]);
  await expect(dataRows(page)).toHaveCount(4);
});

test("the valueless section drags like any other", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");

  // empty one row's role, and the table grows a "No role" section — the one
  // whose key is the empty string, which every truthiness guard drops
  await row(page, "Noa").locator("td").filter({ hasText: "artwork" }).first().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "Clear value" }).click();
  await expect(groupRow(page, "No role")).toHaveCount(1);
  expect(await sectionOrder(page)).toEqual([
    "mix engineer",
    "booking",
    "radio plugger",
    "No role",
  ]);

  await dragSectionBefore(page, "No role", "mix engineer");
  const expected = ["No role", "mix engineer", "booking", "radio plugger"];
  expect(await sectionOrder(page)).toEqual(expected);
  await reopenContacts(page);
  expect(await sectionOrder(page)).toEqual(expected);
});

test("a folded header is exactly as tall as an open one", async ({ page }) => {
  await page.goto("/");
  await openContacts(page);
  await groupTableBy(page, "role");

  // not the first section: that one sits under the sticky header on its own
  // tighter padding, and a windowed table measures a header it can see
  const artwork = groupRow(page, "artwork");
  const open = await artwork.boundingBox();
  await artwork.locator(".db-group-disclose").click();
  await expect(artwork).toHaveClass(/is-collapsed/);
  const folded = await artwork.boundingBox();
  const booking = await groupRow(page, "booking").boundingBox();

  // one measured header height lays out every section in a windowed table,
  // so a folded header off by even a few px walks the scroll geometry
  expect(Math.abs(folded!.height - open!.height)).toBeLessThan(0.5);
  expect(Math.abs(folded!.height - booking!.height)).toBeLessThan(0.5);
});
