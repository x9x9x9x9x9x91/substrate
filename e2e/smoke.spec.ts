import { expect, test, type Page } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// Smoke flows against the deterministic mock backend (src/lib/tauri.ts —
// active whenever the app runs outside Tauri). Each test gets a fresh page,
// so mock state never leaks between flows.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

// palette actions on a found note: ⌘K → query → Tab → filter "trash" → Enter
async function trashViaPalette(page: Page, query: string, title: string) {
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill(query);
  // the selected row is the best match — querying the open note also spawns
  // an "Actions: …" item, so match the selected row, not any row
  await expect(page.locator(".palette-item.selected")).toContainText(title);
  await page.keyboard.press("Tab");
  await input.fill("trash");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);
}

// proof a path's snapshots are gone: the History panel's purge-by-path
// refuses when it finds none (and would proceed if any survived)
async function expectHistoryGone(page: Page, path: string) {
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await row(page, "Welcome").click();
  await page.locator(".note-tool[aria-label=History]").click();
  await page.locator(".hist-danger-link", { hasText: "Purge a deleted note…" }).click();
  await page.locator(".hist-purge-datelabel .hist-purge-input").fill(path);
  await page.locator(".hist-purge-confirm .hist-purge-input").fill("purge");
  await page.locator(".hist-purge-go").click();
  await expect(page.locator(".hist-error")).toContainText("No snapshots found");
}

function chip(page: Page, key: string) {
  return page.locator(".chip").filter({ has: page.locator(".chip-key", { hasText: key }) });
}

async function boot(page: Page) {
  await page.goto("/");
  // cold open lands on the Notes scratch list (Today is a destination, SUB-300) —
  // these flows build on the scratch list and its first-note selection
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  // notes view (untyped, recency-first), first mock note selected and loaded
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("open note, edit, body round-trips", async ({ page }) => {
  await row(page, "Capture anything").click();
  await expect(page.getByRole("textbox", { name: "Note title", exact: true })).toHaveValue(
    "Capture anything"
  );
  const editor = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(editor).toBeVisible();

  const marker = `E2E-MARKER ${Date.now()}`;
  await editor.click();
  await page.keyboard.type(marker);

  // leaving the note flushes the debounced write (NotePane cleanup), so the
  // round-trip below exercises mock write → read, not just local state
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await row(page, "Capture anything").click();
  await expect(page.locator(".cm-content")).toContainText(marker);
});

test("chip edit via picker, chip add via key:value", async ({ page }) => {
  // typed notes live in their databases: All notes collapses them into the
  // database block (SUB-87) — click through, then open the entry
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await expect(page.locator(".db-table")).toBeVisible();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");

  // schema'd prop edits through the SelectMenu picker
  await chip(page, "status").click();
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await menu.locator(".selmenu-item", { hasText: "mastering" }).click();
  await expect(menu).toHaveCount(0);
  await expect(chip(page, "status").locator(".chip-val")).toHaveText("mastering");

  // free-form prop via the + property input
  await page.locator(".chip-add").click();
  const add = page.locator(".chip-input");
  await add.fill("mood: nocturnal");
  await add.press("Enter");
  await expect(chip(page, "mood").locator(".chip-val")).toHaveText("nocturnal");
});

test("⌘K palette: open, search, enter", async ({ page }) => {
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill("vessel");
  await expect(page.locator(".palette-item.selected")).toContainText("Vessel Songs");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".note-title")).toHaveValue("Vessel Songs");
});

test("database: table ↔ board toggle", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  await page.locator(".db-switch button[title=\"Board\"]").click();
  await expect(page.locator(".db-board")).toBeVisible();
  // every mock release has a status — the four schema options, no "No status"
  // column (SUB-168: it only appears while a card actually lacks the prop)
  await expect(page.locator(".db-col")).toHaveCount(4);

  await page.locator(".db-switch button[title=\"Table\"]").click();
  await expect(page.locator(".db-table")).toBeVisible();
});

test("table aggregation footer: pick, compute, persist (SUB-74)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  // SUB-945: the footer rests there with no aggregation set — row count in
  // the title cell, and a "Calc" ghost per column that stays out of the way
  // until the footer is hovered, without ever moving the table's geometry
  await expect(page.locator(".db-table tfoot")).toHaveCount(1);
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  const tracksGhost = page.locator('.db-agg-cell[data-col="tracks"] .db-agg-ghost');
  await expect(tracksGhost).toHaveText("Calc");
  await expect(tracksGhost).toHaveCSS("opacity", "0");
  // per-CELL reveal (SUB-945 review round): only the hovered cell's ghost
  // wakes, so a resting footer never lights up wholesale
  await page.locator('.db-agg-cell[data-col="tracks"]').hover();
  await expect(tracksGhost).toHaveCSS("opacity", "1");

  // first calculation starts from the column caret — Sum over the numeric
  // tracks column
  await page.locator(".db-table th", { hasText: "tracks" }).locator(".db-th-caret").click();
  await page.locator(".colmenu .dots-item", { hasText: "Calculate…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: /^Sum$/ }).click();

  // the column fills in: Sum 42 under tracks
  const tracks = page.locator('.db-agg-cell[data-col="tracks"]');
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  await expect(tracks.locator(".db-agg-kind")).toHaveText("Sum");
  await expect(tracks.locator(".db-agg-value")).toHaveText("42");

  // a second column through the footer picker: Count over artist
  await page.locator('.db-agg-cell[data-col="artist"] .db-agg-btn').click();
  await page.locator(".colmenu .dots-item", { hasText: /^Count$/ }).click();
  await expect(page.locator('.db-agg-cell[data-col="artist"] .db-agg-value')).toHaveText("5");

  // persists across view switches (mock vault_views_set round-trip)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openDb(page, "Release");
  await expect(page.locator(".db-agg-title")).toHaveText("5 rows");
  await expect(page.locator('.db-agg-cell[data-col="tracks"] .db-agg-value')).toHaveText("42");
  await expect(page.locator('.db-agg-cell[data-col="artist"] .db-agg-value')).toHaveText("5");

  // the active option is marked; setting both back to None returns the
  // footer to rest — still mounted, back to ghosts (SUB-945)
  await tracks.locator(".db-agg-btn").click();
  await expect(page.locator(".colmenu .dots-item", { hasText: "✓ Sum" })).toHaveCount(1);
  await page.locator(".colmenu .dots-item", { hasText: /^None$/ }).click();
  await expect(tracks.locator(".db-agg-ghost")).toHaveText("Calc");
  await page.locator('.db-agg-cell[data-col="artist"] .db-agg-btn').click();
  await page.locator(".colmenu .dots-item", { hasText: /^None$/ }).click();
  await expect(page.locator(".db-table tfoot")).toHaveCount(1);
  await expect(page.locator('.db-agg-cell[data-col="artist"] .db-agg-ghost')).toHaveText("Calc");
});

test("board: drag card between columns", async ({ page }) => {
  await openDb(page, "Release");
  await page.locator(".db-switch button[title=\"Board\"]").click();

  const card = page.locator(".db-card", { hasText: "Slow Bloom EP" });
  const live = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "live" }),
  });
  const inReview = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "in review" }),
  });
  await expect(inReview.locator(".db-card")).toHaveCount(1);

  await card.dragTo(live);

  await expect(live.locator(".db-card", { hasText: "Slow Bloom EP" })).toBeVisible();
  await expect(inReview.locator(".db-card")).toHaveCount(0);
});

test("board: No status column only while a card lacks the prop; empty columns get a drop zone (SUB-168)", async ({
  page,
}) => {
  // (a) all five mock releases carry a status — no "No status" column, and
  // the empty schema column ("parked") shows a designed drop zone
  await openDb(page, "Release");
  await page.locator(".db-switch button[title=\"Board\"]").click();
  await expect(page.locator(".db-col")).toHaveCount(4);
  await expect(page.locator(".db-col-head", { hasText: "No status" })).toHaveCount(0);
  const parked = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "parked" }),
  });
  await expect(parked.locator(".db-col-empty")).toBeVisible();

  // (b) a release born without a status, created through the app itself:
  // plain scratch note → Database chip → release (commits the type prop only)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await page.keyboard.press("Meta+n");
  const newTitle = page.locator(".note-title");
  await expect(newTitle).toHaveValue("Untitled");
  // ⌘N focuses the title on an 80ms timeout — wait for it before typing
  await expect(newTitle).toBeFocused();
  await page.keyboard.type("Ghost release");
  await page.keyboard.press("Enter");
  // reopen from the list so the chip commits against the post-rename path
  await row(page, "Ghost release").click();
  await expect(page.locator(".note-title")).toHaveValue("Ghost release");
  await chip(page, "Database").click();
  const typeMenu = page.locator(".selmenu");
  await expect(typeMenu).toBeVisible();
  // picking a type pulls the note out of the untyped Notes list — the open
  // note switches, so verify at the board, not on the chip
  await typeMenu.locator(".selmenu-item", { hasText: "release" }).click();

  await openDb(page, "Release");
  await page.locator(".db-switch button[title=\"Board\"]").click();
  const none = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "No status" }),
  });
  await expect(page.locator(".db-col")).toHaveCount(5);
  await expect(none.locator(".db-card", { hasText: "Ghost release" })).toBeVisible();

  // drag-to-clear: dropping a grouped card on "No status" strips its prop
  await page.locator(".db-card", { hasText: "Slow Bloom EP" }).dragTo(none);
  await expect(none.locator(".db-card", { hasText: "Slow Bloom EP" })).toBeVisible();
});

test("board: drag a card into an empty schema column (SUB-168)", async ({ page }) => {
  await openDb(page, "Release");
  await page.locator(".db-switch button[title=\"Board\"]").click();
  const parked = page.locator(".db-col", {
    has: page.locator(".db-col-head", { hasText: "parked" }),
  });
  // the ghost zone marks the column as a drop place; it has no cards yet
  await expect(parked.locator(".db-col-empty")).toBeVisible();
  await expect(parked.locator(".db-card")).toHaveCount(0);

  // title-scoped: another card's subtitle carries the artist "glass havens"
  const glassHavens = page.locator(".db-card", {
    has: page.locator(".db-card-title", { hasText: "Glass Havens" }),
  });
  await glassHavens.dragTo(parked);

  await expect(parked.locator(".db-card", { hasText: "Glass Havens" })).toBeVisible();
  await expect(parked.locator(".db-col-empty")).toHaveCount(0);
});

test("trash → restore", async ({ page }) => {
  // delete via palette actions: ⌘K → query → Tab → filter "trash" → Enter
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("rondo");
  await expect(page.locator(".palette-item", { hasText: "Rondo MX180" })).toBeVisible();
  await page.keyboard.press("Tab");
  await input.fill("trash");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(row(page, "Rondo MX180")).toHaveCount(0);

  await page.locator(".side-item", { hasText: "Trash" }).click();
  const entry = page.locator(".trash-row", { hasText: "Rondo MX180" });
  await expect(entry).toBeVisible();
  await entry.locator(".trash-restore").click();

  // restore lands in All notes with the note open and its body intact
  await expect(page.locator(".note-title")).toHaveValue("Rondo MX180");
  await expect(page.locator(".cm-content")).toContainText("Rotary mixer");
});

test("sidebar reorder: Move up/down via the context menu (SUB-58)", async ({ page }) => {
  const sideTitles = async (names: string[]) => {
    const texts = await page.locator(".side-item .side-label-text").allTextContents();
    return texts.filter((t) => names.includes(t));
  };
  // the machine-bridge dashboards are absent from builds that strip them, so
  // the expected order is derived from what the sidebar actually offers rather
  // than hard-coded (SUB-589)
  const dashNames = [
    "Calories",
    "Overview",
    "Portfolio",
  ];
  const inOrder = await sideTitles(dashNames);
  expect(inOrder).toEqual(dashNames);

  // the top item's Move up is disabled; Move down swaps it one slot
  await page.locator(".side-item", { hasText: "Calories" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveClass(/disabled/);
  await page.locator(".ctx-item", { hasText: "Move down" }).click();
  const swapped = [inOrder[1], inOrder[0], ...inOrder.slice(2)];
  expect(await sideTitles(dashNames)).toEqual(swapped);

  // databases no longer reorder: the flat sidebar section this served is gone
  // (SUB-159) — the manager's row menu carries no Move up/down
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveCount(0);
  await expect(page.locator(".ctx-item", { hasText: "Move down" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("sheet: cell edit recomputes formula column", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All notes" }).click();
  // sheets are surfaces, not a database (SUB-389): they list as loose rows
  await page.locator('.list .row[data-path="Holdings.md"]').click();
  await expect(page.locator(".note-title")).toHaveValue("Holdings");
  await expect(page.locator(".sheet-table")).toBeVisible();

  // BTC row: units 4.1 × 64.200 = 263.220 (value_usd — FX-independent)
  // data cells render through the grid-wide formatter (de-DE, SUB-282):
  // dot thousands, comma decimals; fractions get 2 decimals
  const btc = page.locator(".sheet-table tbody tr").nth(1);
  await expect(btc.locator("td").nth(2).locator(".sheet-cell")).toHaveText("4,10");
  await expect(btc.locator("td").nth(4).locator(".sheet-cell")).toContainText("263.220");

  await btc.locator("td").nth(2).locator(".sheet-cell").dblclick();
  const input = btc.locator("input.sheet-input");
  await input.fill("5");
  await input.press("Enter");

  await expect(btc.locator("td").nth(4).locator(".sheet-cell")).toContainText("321.000");
});

test("saved view: filter, pin, open, remove (SUB-18)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  // the filter bar narrows live — trailing space commits the operator
  await (await openFilter(page)).fill("status:live ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".list-count")).toHaveText("2 of 5");

  // pin it via the view-actions menu
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  const pin = page.locator(".side-view", { hasText: "Live releases" });
  await expect(pin).toHaveCount(1);

  // pins nest under their database's sidebar row; homeless dbs (the mock's
  // Release) hang them off All databases — the standalone Saved views
  // section is gone
  await expect(page.locator(".side-label-row", { hasText: "Saved views" })).toHaveCount(0);
  await expect(pin).toHaveCount(1);

  // leave and reopen through the pin: query and rows come back — the title
  // stays the database's, the pin's name rides the active tab
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await pin.click();
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-tab.active")).toHaveText("Live releases⌘5");
  await expect(page.locator(".db-filter-input")).toHaveValue("status:live");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  // right-click → remove; the open pin falls back to its database
  await pin.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove pin" }).click();
  await expect(page.locator(".side-view")).toHaveCount(0);
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);
});

test("database filter: date comparison due < 7d (SUB-66)", async ({ page }) => {
  await page
    .locator(".side-item", { has: page.locator(".side-db-chip") })
    .filter({ has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .click();
  // SUB-182 density: 17 seeded tasks
  await expect(page.locator(".db-table tbody tr")).toHaveCount(17);

  // mock task dues run day −8 … +16 around today — `due < 7d` keeps the 13
  // inside the window, dropping only +8, +11, +16 and the seeded +9
  await (await openFilter(page)).fill("due < 7d ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(13);
  await expect(page.locator(".list-count")).toHaveText("13 of 17");
  await expect(
    page.locator(".db-table tbody tr", { hasText: "Send SMP-029 promos" })
  ).toHaveCount(0);

  // a half-typed operand narrows nothing
  await (await openFilter(page)).fill("due < 7");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(17);
});

test("database filter: multi-value OR + saved view round-trip (SUB-78)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  // comma = OR over one prop: live ∪ in review = 3 of 5 (both mastering out).
  // the segment with a space must quote, like a single value would
  await (await openFilter(page)).fill('status:live,"in review" ');
  await expect(page.locator(".db-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".list-count")).toHaveText("3 of 5");
  await expect(page.locator(".db-table .db-title", { hasText: "Vessel Songs" })).toHaveCount(0);
  await expect(page.locator(".db-table .db-title", { hasText: "Fern Palace" })).toHaveCount(0);

  // pin it via the filter bar's Save view button
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live or in review");
  await nameInput.press("Enter");
  const pin = page.locator(".side-view", { hasText: "Live or in review" });
  await expect(pin).toHaveCount(1);

  // leave and reopen through the pin: same query, same union of rows
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await pin.click();
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-tab.active")).toHaveText("Live or in review⌘5");
  await expect(page.locator(".db-filter-input")).toHaveValue('status:live,"in review"');
  await expect(page.locator(".db-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".list-count")).toHaveText("3 of 5");
});

test("multi-select prop: picker toggles values, per-value pills + filter (SUB-79)", async ({
  page,
}) => {
  // Slow Bloom EP seeds format: Vinyl — a scalar, legal for one value; open
  // it through its database block (SUB-87)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row-dbblock", { hasText: "Release" }).click();
  await page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-title")
    .click();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
  const format = chip(page, "format");
  await expect(format.locator(".chip-val")).toHaveText("Vinyl");
  await expect(format.locator(".opt-pill")).toHaveCount(1);

  // the picker toggles membership and stays open for more
  await format.click();
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(
    menu.locator(".selmenu-item", { hasText: "Vinyl" }).locator(".selmenu-cur")
  ).toHaveCount(1);
  await menu.locator(".selmenu-item", { hasText: "Digital" }).click();
  await expect(menu).toBeVisible();
  await expect(
    menu.locator(".selmenu-item", { hasText: "Digital" }).locator(".selmenu-cur")
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // the chip shows both values, one dot each
  await expect(format.locator(".chip-val")).toContainText("Vinyl");
  await expect(format.locator(".chip-val")).toContainText("Digital");
  await expect(format.locator(".opt-pill")).toHaveCount(2);

  // the db table cell renders both values with their dots
  await openDb(page, "Release");
  const cell = page
    .locator(".db-table tbody tr", { hasText: "Slow Bloom EP" })
    .locator(".db-cell", { hasText: "Digital" });
  await expect(cell).toContainText("Vinyl");
  await expect(cell.locator(".opt-pill")).toHaveCount(2);

  // the filter bar matches per value: both Vinyl releases hit format:vinyl
  await (await openFilter(page)).fill("format:vinyl ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".list-count")).toHaveText("2 of 5");
});

test("⌘5 opens the first pinned view (SUB-67)", async ({ page }) => {
  // pin a filtered view on the Release database (the SUB-18 flow)
  await openDb(page, "Release");
  await (await openFilter(page)).fill("status:live ");
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "Live releases" })).toHaveCount(1);

  // leave, then ⌘5 jumps straight back to the pin — same as clicking it
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-tab.active")).toHaveText("Live releases⌘5");
  await expect(page.locator(".db-filter-input")).toHaveValue("status:live");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
});

test("notes: untyped scratch list, ⌘2 jump, ⌘N instant note (SUB-70)", async ({ page }) => {
  // boot leaves us on Notes: untyped AND unfiled only (SUB-390), recency-first
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(page.locator(".list .row")).toHaveCount(3);
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "Umbra")).toHaveCount(0); // untyped but filed (Projects/) — its folder owns it
  await expect(row(page, "Slow Bloom EP")).toHaveCount(0); // typed — lives in its database
  await expect(page.locator(".side-item:not(.side-folder)", { hasText: "Inbox" })).toHaveCount(0);
  await expect(page.locator(".side-item:not(.side-folder)", { hasText: "Recent" })).toHaveCount(0);

  // ⌘3 → All notes collapses typed notes into their database blocks (SUB-87);
  // the block clicks through to the database, ⌘2 jumps back to Notes
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".list-title")).toHaveText("All notes");
  await expect(row(page, "Slow Bloom EP")).toHaveCount(0);
  const releaseBlock = page.locator(".row-dbblock", { hasText: "Release" });
  await expect(releaseBlock).toContainText("5 entries");
  await releaseBlock.click();
  await expect(page.locator(".db-table")).toBeVisible();
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".list-title")).toHaveText("Notes");

  // ⌘N in Notes: instant untyped note on top, cursor in the title, no dialog
  await page.keyboard.press("Meta+n");
  const title = page.locator(".note-title");
  await expect(title).toHaveValue("Untitled");
  await expect(title).toBeFocused();
  await page.keyboard.type("Scratch idea");
  await page.keyboard.press("Enter");
  await expect(page.locator(".list .row").first()).toContainText("Scratch idea");

  // ⌘N again dedupes on disk instead of clobbering the first note
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await expect(row(page, "Scratch idea")).toBeVisible();
});

test("sidebar: section chevrons collapse and re-expand (SUB-70)", async ({ page }) => {
  // the flat Databases section is gone (SUB-159): one persistent "All
  // databases" nav row in its place — a plain item, no collapsible section
  const mgr = page.locator(".side-item", { hasText: "All databases" });
  await expect(mgr).toBeVisible();
  await expect(mgr.locator(".side-chevron")).toHaveCount(0);
  await expect(page.locator(".side-label-row", { hasText: "Databases" })).toHaveCount(0);

  const inboxFolder = page.locator(".side-folder", { hasText: "Inbox" });
  await expect(inboxFolder).toBeVisible();
  const folderHeader = page.locator(".side-label-row", { hasText: "Folders" });
  await folderHeader.locator(".side-chevron").click();
  await expect(inboxFolder).toHaveCount(0);
  await folderHeader.locator(".side-chevron").click();
  await expect(inboxFolder).toBeVisible();

  const dash = page.locator(".side-item", { hasText: "Overview" });
  await expect(dash).toBeVisible();
  await page.locator(".side-label-row", { hasText: "Dashboards" }).locator(".side-chevron").click();
  await expect(dash).toHaveCount(0);
});

test("database icons: picker sets glyph, tint, emoji; manager/palette follow (SUB-27)", async ({
  page,
}) => {
  // seeded mock icons: release = violet music glyph, task = 🎵 emoji — the
  // manager row carries them (SUB-159: the flat sidebar db row's replacement)
  const relItem = page.locator(".dbmgr-row", { hasText: "Release" });
  const openManager = async () => {
    await page.locator(".side-item", { hasText: "All databases" }).click();
    await expect(relItem).toBeVisible();
  };
  await openManager();
  await expect(relItem.locator("svg.type-icon")).toBeVisible();
  await expect(relItem.locator("svg.type-icon")).toHaveCSS("color", "rgb(168, 135, 240)");

  // the header icon button opens the picker
  await relItem.click();
  await page.locator(".db-icon-btn").click();
  const pick = page.locator(".iconpick");
  await expect(pick).toBeVisible();
  await expect(pick.locator(".iconpick-glyph").first()).toBeVisible();

  // glyph click saves and keeps the popover open (tint survives the switch)
  await pick.locator('.iconpick-glyph[title="star"]').click();
  await expect(pick.locator('.iconpick-glyph[title="star"]')).toHaveClass(/active/);
  await openManager();
  await expect(relItem.locator("svg.type-icon")).toHaveCSS("color", "rgb(168, 135, 240)");

  // tint swatch recolors the glyph everywhere
  await relItem.click();
  await page.locator(".db-icon-btn").click();
  await pick.locator('.iconpick-swatch[data-tint="teal"]').click();
  await expect(page.locator(".db-icon-btn svg.type-icon")).toHaveCSS("color", "rgb(76, 194, 186)");
  await openManager();
  await expect(relItem.locator("svg.type-icon")).toHaveCSS("color", "rgb(76, 194, 186)");

  // emoji replaces the glyph; tint row disables (emoji render full-color)
  await relItem.click();
  await page.locator(".db-icon-btn").click();
  await pick.locator(".iconpick-emoji-input").fill("🎧");
  await pick.locator(".iconpick-emoji-input").press("Enter");
  await expect(page.locator(".db-icon-btn .type-icon-emoji")).toHaveText("🎧");
  await expect(pick.locator(".iconpick-swatches")).toHaveClass(/disabled/);
  await page.keyboard.press("Escape");
  await expect(pick).toHaveCount(0);

  // icon survives navigation within the session (mock state)
  await openManager();
  await expect(relItem.locator(".type-icon-emoji")).toHaveText("🎧");

  // palette results carry the icons too — seeded task emoji + the new release one
  await page.keyboard.press("Meta+k");
  await expect(
    page.locator(".palette-item", { hasText: "Go to Task" }).locator(".type-icon-emoji")
  ).toHaveText("🎵");
  await expect(
    page.locator(".palette-item", { hasText: "Go to Release" }).locator(".type-icon-emoji")
  ).toHaveText("🎧");
  await page.keyboard.press("Escape");

  // Remove strips the schema icon — release falls back to its curated
  // default (SUB-183: violet glyph) instead of the old auto-letter chip
  await relItem.click();
  await page.locator(".db-icon-btn").click();
  await pick.locator(".iconpick-remove").click();
  await expect(pick).toHaveCount(0);
  await openManager();
  await expect(relItem.locator("svg.type-icon")).toHaveCSS("color", "rgb(168, 135, 240)");
});

test("curated default icons: icon-less types render the designed glyph + tint (SUB-183)", async ({
  page,
}) => {
  // the mock seeds no schema icon for contact/inventory — the curated map
  // gives each a designed glyph with a muted tint, not the auto-letter chip
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const contact = page.locator(".dbmgr-row", { hasText: "Contact" });
  await expect(contact.locator("svg.type-icon")).toBeVisible();
  await expect(contact.locator(".type-icon-emoji")).toHaveCount(0);
  await expect(contact.locator(".type-icon-auto")).toHaveCount(0);
  await expect(contact.locator("svg.type-icon")).toHaveCSS("color", "rgb(96, 154, 232)");

  const inventory = page.locator(".dbmgr-row", { hasText: "Inventory" });
  await expect(inventory.locator("svg.type-icon")).toHaveCSS("color", "rgb(232, 150, 90)");

  // the tint lives on the glyph stroke only and stays constant on hover
  await contact.hover();
  await expect(contact.locator("svg.type-icon")).toHaveCSS("color", "rgb(96, 154, 232)");
});

test("folder icons: context menu picker sets an icon; sidebar row + header follow (SUB-84)", async ({
  page,
}) => {
  // seeded mock meta: Projects boots with a 🌱 emoji (the read path) — the
  // explicit icon beats its "projects" curated name default (SUB-391)
  const projects = page.locator(".side-folder", { hasText: "Projects" });
  await expect(projects.locator(".type-icon-emoji")).toHaveText("🌱");

  // a folder named after a curated default renders it with no meta at all
  // (SUB-391): Calendar boots with the calendar glyph, not the plain folder
  const calendar = page.locator(".side-folder", { hasText: "Calendar" });
  await expect(calendar.locator("svg.type-icon")).toBeVisible();

  // "Field notes" matches no curated name — it starts plain: just the
  // folder glyph
  const fieldNotes = page.locator(".side-folder", { hasText: "Field notes" });
  await expect(fieldNotes.locator(".type-icon")).toHaveCount(0);

  // right-click → Change icon… → pick a glyph; Escape closes the picker
  await fieldNotes.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Change icon…" }).click();
  const pick = page.locator(".iconpick");
  await expect(pick).toBeVisible();
  await pick.locator('.iconpick-glyph[title="star"]').click();
  await page.keyboard.press("Escape");
  await expect(pick).toHaveCount(0);

  // the sidebar row renders the glyph instead of the folder icon
  await expect(fieldNotes.locator("svg.type-icon")).toBeVisible();

  // the folder view header shows it before the folder name
  await fieldNotes.click();
  await expect(page.locator(".list-title")).toHaveText("Field notes");
  await expect(page.locator(".list-head svg.type-icon")).toBeVisible();

  // Remove icon (offered only when one is set) restores the plain glyph
  await fieldNotes.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove icon" }).click();
  await expect(fieldNotes.locator(".type-icon")).toHaveCount(0);
});

test("database home folders: the db nests into the Folders tree (SUB-85)", async ({ page }) => {
  // seeded mock home: task → Tasks/ — the tree row keeps the FOLDER name
  // (SUB-611) but wears the db icon and a DB chip; no other sidebar row
  // (SUB-159: the flat homeless-db section is gone). SUB-686 dropped the
  // per-row entry counts — Notion-style quiet rows.
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await expect(treeRow).toBeVisible();
  await expect(treeRow.locator(".type-icon-emoji")).toHaveText("🎵");
  await expect(treeRow.locator(".side-db-chip")).toHaveText("DB");
  await expect(treeRow.locator(".side-count")).toHaveCount(0);
  await expect(
    page.locator(".side-item:not(.side-folder)", {
      has: page.locator(".side-label-text", { hasText: /^Task$/ }),
    })
  ).toHaveCount(0);

  // clicking it opens the database view, not the folder's file list
  await treeRow.click();
  await expect(page.locator(".db-table")).toBeVisible();
  // SUB-182 density: 17 seeded tasks
  await expect(page.locator(".db-table tbody tr")).toHaveCount(17);

  // a new entry from the database view lands in the home folder explicitly
  await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  await draft.fill("E2E home landing");
  await draft.press("Enter");
  await expect(page.locator(".db-table tr", { hasText: "E2E home landing" })).toBeVisible();

  // its context menu is the database menu: Show files, no section reorder
  await treeRow.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Move up" })).toHaveCount(0);
  await page.locator(".ctx-item", { hasText: "Show files" }).click();

  // …and the home folder's file list opens — its entries collapse into the
  // database block (SUB-87), the new entry counted in it
  await expect(page.locator(".list-title")).toHaveText("Tasks");
  await expect(row(page, "Master Vessel Songs v3")).toHaveCount(0);
  const taskBlock = page.locator(".row-dbblock", { hasText: "Task" });
  // 17 seeded + the entry drafted above (SUB-182 density)
  await expect(taskBlock).toContainText("18 entries");
  await taskBlock.click();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(18);
});

test("vanished file: empty state, app survives (SUB-54)", async ({ page }) => {
  // "Vanished note" is the mock fixture whose vault_read always rejects —
  // opening it must show the gone-file empty state, not crash the pane
  await row(page, "Vanished note").click();
  await expect(page.locator(".note .empty")).toContainText("file is gone");

  // the app survives: list still works, another note opens fine
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
});

test("move collision surfaces a toast instead of failing silently (SUB-58)", async ({ page }) => {
  // seed the collision without create-time duplicates: ⌘N captures "Welcome"
  // into the Inbox, which holds no note of that name yet — create-time dedupe
  // is per-folder (SUB-65), so it lands at Inbox/Welcome.md exactly, and the
  // root note of the same name collides with it on a move. ⌘N is capture
  // everywhere except the Notes view (SUB-70), so go to All notes first.
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+n");
  await page.locator(".palette-input").fill("Welcome");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);

  // drag the root Welcome onto the Inbox folder — the name is taken there
  await page.locator(".side-item", { hasText: "All notes" }).click();
  const source = page.locator(".list .row[data-path='Welcome.md']");
  await expect(source).toBeVisible();
  await source.dragTo(page.locator(".side-folder", { hasText: "Inbox" }));

  // the engine's rejection is visible, and the note stayed put
  await expect(page.locator(".toast")).toContainText("already exists in Inbox");
  await expect(page.locator(".list .row[data-path='Welcome.md']")).toBeVisible();
});

test("create dedupes filenames per folder like the engine (SUB-65)", async ({ page }) => {
  // "Capture anything" already sits in the Inbox — capturing the same title
  // again must dedupe to a numbered sibling, never duplicate the path. ⌘N is
  // capture everywhere except the Notes view (SUB-70), so go to All notes first.
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+n");
  await page.locator(".palette-input").fill("Capture anything");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);

  // the original is untouched and the sibling is numbered, its title following
  // the deduped filename — the engine's Idea.md, Idea 2.md… rule
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(
    page.locator(".list .row[data-path='Inbox/Capture anything.md']")
  ).toBeVisible();
  await expect(
    page.locator(".list .row[data-path='Inbox/Capture anything 2.md']")
  ).toBeVisible();
  await expect(row(page, "Capture anything 2")).toBeVisible();
});

test("folder trash → restore brings back the whole subtree (SUB-58)", async ({ page }) => {
  // right-click the Calendar folder in the sidebar → Move to Trash
  await page.locator(".side-folder", { hasText: "Calendar" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();
  await expect(page.locator(".side-folder", { hasText: "Calendar" })).toHaveCount(0);

  // the whole subtree lists as one folder entry in the Trash pane
  await page.locator(".side-item", { hasText: "Trash" }).click();
  const entry = page.locator(".trash-row", { hasText: "Calendar" });
  await expect(entry).toBeVisible();
  // 6 seeded events live in Calendar/ (SUB-182 density + SUB-270's timed one
  // + SUB-646's ranged one)
  await expect(entry).toContainText("6 notes");
  await entry.locator(".trash-restore").click();

  // restore lands on the folder view with the whole subtree back — the
  // events list as their database block (SUB-87)
  await expect(page.locator(".side-folder", { hasText: "Calendar" })).toBeVisible();
  await expect(page.locator(".row-dbblock", { hasText: "Event" })).toContainText("6 entries");
});

test("trash: delete forever can also purge history (SUB-52)", async ({ page }) => {
  // seed snapshots for the note first, so the purge has something to destroy
  await row(page, "Capture anything").click();
  await page.locator(".note-tool[aria-label=History]").click();
  await expect(page.locator(".hist-item")).toHaveCount(3);
  await page.locator(".hist-close").click();

  await trashViaPalette(page, "capture", "Capture anything");

  await page.locator(".side-item", { hasText: "Trash" }).click();
  const entry = page.locator(".trash-row", { hasText: "Capture anything" });
  await expect(entry).toBeVisible();
  await entry.locator(".trash-danger", { hasText: "Delete forever…" }).click();
  await entry.locator(".trash-also").click();
  await entry.locator(".trash-danger", { hasText: "Forever?" }).click();
  await expect(entry).toHaveCount(0);

  await expectHistoryGone(page, "Inbox/Capture anything.md");
});

test("trash: empty trash can purge all history in one go (SUB-52)", async ({ page }) => {
  // seed snapshots for one of the two doomed notes — a gear entry opens via
  // the palette; All notes lists it collapsed into its db block (SUB-87)
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("rondo");
  await expect(page.locator(".palette-item.selected")).toContainText("Rondo MX180");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Rondo MX180");
  await page.locator(".note-tool[aria-label=History]").click();
  await expect(page.locator(".hist-item")).toHaveCount(3);
  await page.locator(".hist-close").click();

  await trashViaPalette(page, "rondo", "Rondo MX180");
  await trashViaPalette(page, "static", "Static Bouquet");

  await page.locator(".side-item", { hasText: "Trash" }).click();
  await expect(page.locator(".trash-row")).toHaveCount(2);
  await page.locator(".trash-danger", { hasText: "Empty trash…" }).click();
  await page.locator(".list-head .trash-also").click();
  await page.locator(".trash-danger", { hasText: "Delete 2 notes forever?" }).click();
  await expect(page.locator(".trash-body .empty")).toContainText("Trash is empty");

  await expectHistoryGone(page, "Rondo MX180.md");
});

/** local YYYY-MM-DD, same as the app's todayIso() */
function todayIso(): string {
  const t = new Date();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${t.getFullYear()}-${m}-${d}`;
}

test("database new entry is born complete: schema chips + template body (SUB-17)", async ({
  page,
}) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  await draft.fill("Test Pressing");
  await draft.press("Enter");

  // the new row lands in the table and opens in the side split
  const newRow = page.locator(".db-table tr", { hasText: "Test Pressing" });
  await expect(newRow).toBeVisible();
  await newRow.locator(".db-title").click();
  const split = page.locator(".db-note");
  await expect(split.locator(".note-title")).toHaveValue("Test Pressing");

  // every schema prop is born on the note: the template's default filled
  // (status: parked), the rest as empty chips ready to fill
  const splitChip = (key: string) =>
    split.locator(".chip").filter({ has: page.locator(".chip-key", { hasText: key }) });
  await expect(splitChip("status").locator(".chip-val")).toHaveText("parked");
  await expect(splitChip("released")).toHaveCount(1);
  await expect(splitChip("released").locator(".chip-val")).toHaveText("");
  await expect(splitChip("contract")).toHaveCount(1);
  await expect(splitChip("contract").locator(".chip-val")).toHaveText("");
  // the reserved icon key rides the schema entry but is never born as a chip
  await expect(splitChip("icon")).toHaveCount(0);

  // the body is the instantiated template: title + today's date substituted
  // (CodeMirror hides the ## marks outside the cursor line)
  await expect(split.locator(".cm-content")).toContainText("Tracks");
  await expect(split.locator(".cm-content")).toContainText("Test Pressing — opener");
  await expect(split.locator(".cm-content")).toContainText(`announced ${todayIso()}`);
});

test("palette: New from template… lists types, creates born-complete (SUB-17)", async ({
  page,
}) => {
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await expect(input).toBeFocused();
  await input.fill("template");
  await page.locator(".palette-item", { hasText: "New from template…" }).click();

  // every database type is offered; templated types lead, marked (event and
  // release both carry one — pick the release row regardless of count order)
  const release = page.locator(".palette-item", { hasText: "New release…" });
  await expect(release).toHaveCount(1);
  await expect(release.locator(".palette-hint")).toHaveText("template");
  await expect(page.locator(".palette-item", { hasText: "New gear…" })).toBeVisible();
  await release.click();

  // title stage → Enter creates (the typed title filters down to the create row)
  await input.fill("Second Pressing");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await page.keyboard.press("Enter");

  // created and opened: template body + schema chips in place
  await expect(page.locator(".note-title")).toHaveValue("Second Pressing");
  await expect(page.locator(".cm-content")).toContainText("Second Pressing — opener");
  await expect(chip(page, "status").locator(".chip-val")).toHaveText("parked");
  await expect(chip(page, "released")).toHaveCount(1);
});

test("palette: edit a type template in-app, edits persist (SUB-59)", async ({ page }) => {
  // ⌘K → New from template… → release → Edit release template
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("template");
  await page.locator(".palette-item", { hasText: "New from template…" }).click();
  await page.locator(".palette-item", { hasText: "New release…" }).click();
  await page.locator(".palette-item", { hasText: "Edit release template" }).click();
  await expect(page.locator(".overlay")).toHaveCount(0);

  // the template opens like a note: fixed type header, defaults as chips, body
  await expect(page.locator(".note-title-template")).toContainText("release");
  await expect(chip(page, "status").locator(".chip-val")).toHaveText("parked");
  await expect(page.locator(".cm-content")).toContainText("Tracks");

  // body edits go through the hidden-path write exception and persist
  const marker = `E2E-TEMPLATE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await row(page, "Welcome").click(); // leaving flushes the debounced write

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("template");
  await page.locator(".palette-item", { hasText: "New from template…" }).click();
  await page.locator(".palette-item", { hasText: "New release…" }).click();
  await page.locator(".palette-item", { hasText: "Edit release template" }).click();
  await expect(page.locator(".cm-content")).toContainText(marker);
});

test("palette: create a missing type template in-app (SUB-59)", async ({ page }) => {
  // task has a schema but no template file yet → the action offers Create
  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("template");
  await page.locator(".palette-item", { hasText: "New from template…" }).click();
  await page.locator(".palette-item", { hasText: "New task…" }).click();
  await page.locator(".palette-item", { hasText: "Create task template" }).click();
  await expect(page.locator(".overlay")).toHaveCount(0);

  await expect(page.locator(".note-title-template")).toContainText("task");
  const marker = `E2E-NEW-TEMPLATE ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await row(page, "Welcome").click();

  // the type now counts as templated, and the file round-trips
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("template");
  await page.locator(".palette-item", { hasText: "New from template…" }).click();
  const taskRow = page.locator(".palette-item", { hasText: "New task…" });
  await expect(taskRow.locator(".palette-hint")).toHaveText("template");
  await taskRow.click();
  await page.locator(".palette-item", { hasText: "Edit task template" }).click();
  await expect(page.locator(".cm-content")).toContainText(marker);
});

test("calendar new entry is born complete: merged date, schema chips, template (SUB-60)", async ({
  page,
}) => {
  await page.locator(".side-item:not(.side-folder)", { hasText: "Calendar" }).click();
  await expect(page.locator(".cal")).toBeVisible();

  await page.locator(".cal .db-new", { hasText: "New" }).click();
  const draft = page.locator(".cal-draft-input");
  await draft.fill("Listening party");
  await draft.press("Enter");

  // one create, date merged: the entry lands on today's cell immediately
  const todayCell = page.locator(`.cal-day[data-iso="${todayIso()}"]`);
  const entry = todayCell.locator(".cal-entry", { hasText: "Listening party" });
  await expect(entry).toBeVisible();
  // a click opens the entry peek — the note itself is a double-click away
  await entry.dblclick();

  // born complete: date prop is the picked day, the template's location
  // default wins over the schema's empty chip, the body is instantiated
  await expect(page.locator(".note-title")).toHaveValue("Listening party");
  await expect(chip(page, "date").locator(".chip-val")).not.toHaveText("");
  await expect(chip(page, "location").locator(".chip-val")).toHaveText("Studio");
  await expect(page.locator(".cm-content")).toContainText("Agenda");
  await expect(page.locator(".cm-content")).toContainText("Listening party prep");
});

test("calendar draft type badge opens a picker: icons, pick, Tab, Escape (SUB-91)", async ({
  page,
}) => {
  await page.locator(".side-item:not(.side-folder)", { hasText: "Calendar" }).click();
  await expect(page.locator(".cal")).toBeVisible();

  await page.locator(".cal .db-new", { hasText: "New" }).click();
  const badge = page.locator(".cal-draft-type");
  const draft = page.locator(".cal-draft-input");
  await expect(badge).toHaveText("event");

  // click the badge → anchored picker over the creatable types, current order
  await badge.click();
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".selmenu-listhead")).toHaveText("Create as");
  await expect(menu.locator(".selmenu-item")).toHaveText([/event/, /release/, /task/]);
  // per-database identity icons — release's is seeded, event's is its
  // curated default (SUB-183); both render as glyphs
  await expect(
    menu.locator(".selmenu-item", { hasText: "release" }).locator("svg.type-icon")
  ).toBeVisible();
  await expect(
    menu.locator(".selmenu-item", { hasText: "event" }).locator("svg.type-icon")
  ).toBeVisible();
  // opening the menu did not commit or cancel the draft
  await expect(draft).toBeVisible();

  // pick → badge updates, menu closes, title input keeps the keyboard flow
  await menu.locator(".selmenu-item", { hasText: "release" }).click();
  await expect(menu).toHaveCount(0);
  await expect(badge).toHaveText("release");
  await expect(draft).toBeFocused();

  // Tab still quick-cycles without opening the menu
  await page.keyboard.press("Tab");
  await expect(badge).toHaveText("task");
  await expect(menu).toHaveCount(0);

  // first Escape closes the menu only, the draft survives; second cancels it
  await badge.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(draft).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(draft).toHaveCount(0);

  // end-to-end: pick a database type and create the entry in the mock vault
  await page.locator(".cal .db-new", { hasText: "New" }).click();
  await page.locator(".cal-draft-type").click();
  await page.locator(".selmenu-item", { hasText: "task" }).click();
  await page.locator(".cal-draft-input").fill("Master v3");
  await page.locator(".cal-draft-input").press("Enter");
  const todayCell = page.locator(`.cal-day[data-iso="${todayIso()}"]`);
  // SUB-182 density: today's cell overflows the 3-chip month cap, and a fresh
  // task sorts past the visible slice — expand the cell to reach it
  await todayCell.locator(".cal-more", { hasText: "more" }).click();
  const entry = todayCell.locator(".cal-entry", { hasText: "Master v3" });
  await expect(entry).toBeVisible();
  // SUB-701: month chips carry identity as the tinted leading bar now (the
  // type icon lives on the roomier week/agenda surfaces). The seeded task
  // icon is an untinted emoji, so typeTint's stable hash names the hue —
  // pink (--opt-pink)
  await expect(entry.locator(".cal-entry-bar")).toBeVisible();
  await expect(entry.locator(".cal-entry-bar")).toHaveCSS(
    "background-color",
    "rgb(221, 127, 189)"
  );
});

test("calendar opt-out: a dated note hides and returns via the dots menu (SUB-175)", async ({
  page,
}) => {
  // Slow Bloom EP (mock) carries released: 2026-08-01 — a PAST date on
  // purpose: on 2026-08-02 the then-future fixture date collided with the
  // real today, adding an 8th entry to today's cell and breaking the
  // overflow counts in weekview + calendarcontrols. Past dates never
  // collide with a moving today.
  const dayCell = page.locator('.cal-day[data-iso="2026-08-01"]');
  const entry = dayCell.locator(".cal-entry", { hasText: "Slow Bloom EP" });

  // open the calendar on August 2026, wherever today sits: "Today" resets a
  // possibly-persisted cursor to the current month, then page the difference
  const showAugust = async () => {
    await page.locator(".side-item:not(.side-folder)", { hasText: "Calendar" }).click();
    await expect(page.locator(".cal")).toBeVisible();
    await page.locator(".cal .db-new", { hasText: "Today" }).click();
    const now = new Date();
    let diff = (2026 - now.getFullYear()) * 12 + (7 - now.getMonth());
    while (diff !== 0) {
      await page
        .locator(`.cal-pager button[title^="${diff > 0 ? "Next" : "Previous"}"]`)
        .click();
      diff += diff > 0 ? -1 : 1;
    }
  };

  const openNote = async () => {
    await page.keyboard.press("Meta+k");
    await page.locator(".palette-input").fill("Slow Bloom EP");
    await expect(page.locator(".palette-item.selected")).toContainText("Slow Bloom EP");
    await page.keyboard.press("Enter");
    await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");
  };

  // the release starts on the grid…
  await showAugust();
  await expect(entry).toBeVisible();

  // …hides via the note's dots menu…
  await openNote();
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Hide from calendar" }).click();
  await showAugust();
  await expect(entry).toHaveCount(0);

  // …and the same menu, now offering the inverse, brings it back
  await openNote();
  await page.locator('.note-tool[aria-label="Note actions"]').click();
  await page.locator(".dots-item", { hasText: "Show in calendar" }).click();
  await showAugust();
  await expect(entry).toBeVisible();
});

test("database management: create → entry → rename → delete keep-notes (SUB-43)", async ({
  page,
}) => {
  // create via the palette command — name + one initial text property
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-item", { hasText: "New database…" }).click();
  const form = page.locator(".dbform");
  await expect(form).toBeVisible();
  await form.locator(".dbform-input").first().fill("books");
  await form.locator(".dbform-addprop").click();
  await form.locator(".dbform-proprow .dbform-input").fill("author");
  await form.locator(".selmenu-btn-primary").click();

  // schema-registered: the manager lists it with zero notes (SUB-152), view opens
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const booksRow = page.locator(".dbmgr-row", { hasText: "books" });
  await expect(booksRow).toBeVisible();
  await expect(booksRow).toContainText("0 entries");
  await booksRow.click();
  await expect(page.locator(".list-title")).toHaveText("Books");
  await expect(page.locator(".empty")).toContainText("Nothing here");

  // first entry; the schema'd column shows even before any note has values
  await page.locator(".db-new").click();
  await page.locator(".db-draft-input").fill("Dune");
  await page.locator(".db-draft-input").press("Enter");
  await expect(page.locator(".db-table")).toBeVisible();
  await expect(page.locator(".db-table th", { hasText: "author" })).toHaveCount(1);

  // rename the database from the view menu — the open view follows
  await page.locator(".dots-btn").click();
  await page.locator(".dots-item", { hasText: "Rename database…" }).click();
  const rename = page.locator(".dbform");
  await rename.locator(".dbform-input").fill("library");
  await rename.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".list-title")).toHaveText("Library");
  await expect(page.locator(".db-table")).toContainText("Dune");
  // the manager row follows the rename
  await page.locator(".side-item", { hasText: "All databases" }).click();
  const libRow = page.locator(".dbmgr-row", { hasText: "library" });
  await expect(libRow).toBeVisible();

  // delete with keep-notes: type stripped, the note survives untyped
  await libRow.click();
  await page.locator(".dots-btn").click();
  await page.locator(".dots-item", { hasText: "Delete database…" }).click();
  const del = page.locator(".dbform");
  await expect(del).toContainText("1 entry");
  await del.locator(".selmenu-btn", { hasText: "Remove database, keep 1 note" }).click();
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(page.locator(".dbmgr-row", { hasText: "library" })).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await row(page, "Dune").click();
  await expect(page.locator(".note-title")).toHaveValue("Dune");
  // membership gone — the note reads as a plain note again (SUB-125 chip)
  await expect(chip(page, "Database").locator(".chip-val")).toHaveText("note");
});

test("property management: add / rename / remove with value strip (SUB-43)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  // add a text property via the table header +
  await page.locator(".db-add-btn").click();
  const propForm = page.locator(".selmenu");
  await propForm.locator(".dbprop-name").fill("mood");
  await propForm.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".db-table th", { hasText: "mood" })).toHaveCount(1);

  // rename status → state via the column caret; values follow the key
  await page.locator(".db-table th", { hasText: "status" }).locator(".db-th-caret").click();
  await page.locator(".dots-item", { hasText: "Rename property…" }).click();
  const rp = page.locator(".dbform");
  await rp.locator(".dbform-input").fill("state");
  await rp.locator(".selmenu-btn-primary").click();
  await expect(page.locator(".db-table th", { hasText: "state" })).toHaveCount(1);
  await expect(page.locator(".db-table th", { hasText: "status" })).toHaveCount(0);
  await expect(page.locator(".db-table")).toContainText("in review");
  await expect(page.locator(".toast")).toContainText("Renamed in 5 notes");

  // remove: schema demote is instant, then the strip dialog offers the sweep
  await page.locator(".db-table th", { hasText: "state" }).locator(".db-th-caret").click();
  await page.locator(".dots-item", { hasText: "Remove property…" }).click();
  const strip = page.locator(".dbform");
  await expect(strip).toContainText("5 notes");
  await strip.locator(".selmenu-btn-danger").click();
  await expect(page.locator(".db-table th", { hasText: "state" })).toHaveCount(0);
  await expect(page.locator(".db-table")).not.toContainText("in review");
});

test("delete database: trash choice moves notes to Trash (SUB-43)", async ({ page }) => {
  // sidebar context menu entry point this time — the task db row, which
  // nests into the Folders tree as its home folder (SUB-85; SUB-611 label
  // = the folder's name)
  const taskRow = page
    .locator(".side-item", { has: page.locator(".side-db-chip") })
    .filter({ has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) });
  await taskRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete database…" }).click();
  const del = page.locator(".dbform");
  // 17 seeded tasks (SUB-182 density)
  await expect(del).toContainText("17 entries");
  await del.locator(".selmenu-btn-danger", { hasText: "Move 17 notes to Trash" }).click();
  // the database is gone; the Tasks FOLDER survives as a plain row (SUB-611
  // keeps the folder name on the dressed row, so the row stays — chip gone)
  const taskFolder = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await expect(taskFolder).toBeVisible();
  await expect(taskFolder.locator(".side-db-chip")).toHaveCount(0);
  await page.locator(".side-item", { hasText: "Trash" }).click();
  await expect(page.locator(".main")).toContainText("Master Vessel Songs v3");
  await expect(page.locator(".main")).toContainText("Send SMP-029 promos");
});

test("capture opens the freshly captured note, not the old list top (SUB-72)", async ({ page }) => {
  // capture from All notes (⌘N is capture everywhere except Notes view)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+n");
  await page.locator(".palette-input").fill("Fresh capture target");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);

  // the OPEN note must be the new capture — before SUB-72 the selection
  // guard snapped back to the previous top note before refresh landed
  await expect(page.locator(".note-title")).toHaveValue("Fresh capture target");
});

test("filing a capture into a database keeps it open (SUB-208)", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+n");
  await page.locator(".palette-input").fill("Filed capture stays open");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".note-title")).toHaveValue("Filed capture stays open");

  // file it: + property → bare `type` opens the Databases picker
  await page.locator(".chip-add").click();
  const add = page.locator(".chip-input");
  await add.fill("type");
  await add.press("Enter");
  const menu = page.locator(".selmenu");
  await expect(menu.locator(".selmenu-listhead", { hasText: "Databases" })).toBeVisible();
  await menu.locator(".selmenu-item", { hasText: "task" }).click();

  // the note re-homed into the task db — before SUB-208 it left the view's
  // scope and the selection guard snapped to another note, losing the capture
  await expect(page.locator(".note-title")).toHaveValue("Filed capture stays open");
  await expect(chip(page, "Database").locator(".chip-val")).toHaveText("task");
});

test("typing a note into a NEW database announces the birth (SUB-470)", async ({ page }) => {
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+n");
  await page.locator(".palette-input").fill("First expense");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);
  await expect(page.locator(".note-title")).toHaveValue("First expense");

  // + property → bare `type` → a name no database has: the Use row mints it
  await page.locator(".chip-add").click();
  const add = page.locator(".chip-input");
  await add.fill("type");
  await add.press("Enter");
  const menu = page.locator(".selmenu");
  await menu.locator(".selmenu-input").fill("expense");
  await menu.locator(".selmenu-item", { hasText: "Use “expense”" }).click();

  // the birth is followed: the app lands IN the new database view with the
  // note open — not teleported to a view that exists nowhere on screen yet
  await expect(page.locator(".list-title")).toHaveText("Expense");
  await expect(page.locator(".note-title")).toHaveValue("First expense");
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Moved to “expense” — new database");

  // the toast's action homes the db on an eponymous root folder (SUB-403
  // reuse rules); setDbHome's own confirmation replaces the birth toast
  await toast.locator("button", { hasText: "Add to sidebar" }).click();
  await expect(page.locator(".toast")).toContainText("now lives in");
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Expense$/ }),
  });
  await expect(treeRow).toBeVisible();

  // filing into an EXISTING database stays quiet (SUB-208 behavior intact)
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.keyboard.press("Meta+n");
  await page.locator(".palette-input").fill("Second expense");
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay")).toHaveCount(0);
  await page.locator(".chip-add").click();
  await page.locator(".chip-input").fill("type");
  await page.locator(".chip-input").press("Enter");
  await page.locator(".selmenu .selmenu-item", { hasText: "expense" }).first().click();
  await expect(page.locator(".note-title")).toHaveValue("Second expense");
  await expect(page.locator(".toast")).toHaveCount(0);

  // db→db birth: re-typing a note already open in a database side split
  // carries it into the NEW database — the SUB-267 leave-clear must not
  // close the pane out from under the follow
  await openDb(page, "Expense");
  await page.locator(".db-title-txt", { hasText: "Second expense" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Second expense");
  await chip(page, "Database").click();
  await expect(page.locator(".selmenu")).toBeVisible();
  await page.locator(".selmenu .selmenu-input").fill("receipt");
  await page.locator(".selmenu-item", { hasText: "Use “receipt”" }).click();
  await expect(page.locator(".list-title")).toHaveText("Receipt");
  await expect(page.locator(".note-title")).toHaveValue("Second expense");
  await expect(page.locator(".toast")).toContainText("Moved to “receipt” — new database");
});

test("view embed: inline db table, row click-through, unknown-type card (SUB-86)", async ({
  page,
}) => {
  // the seeded hub note carries a ```view fence over the release db — filed
  // under Projects/, so it lives in its folder view now (SUB-390)
  await page.locator(".side-folder", { hasText: "Projects" }).click();
  await row(page, "Umbra").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");

  const embed = page.locator(".embed-view").first();
  await expect(embed).toBeVisible();
  await expect(embed.locator(".embed-view-name")).toHaveText("Release");
  await expect(embed.locator(".embed-view-count")).toHaveText("2");
  // title + the db's first four columns (dbColumns order)
  await expect(embed.locator(".embed-view-table thead th")).toHaveText([
    "title",
    "status",
    "cat#",
    "artist",
    "created",
  ]);
  // status:mastering, recency-first like the vault list
  const rows = embed.locator(".embed-view-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Fern Palace");
  await expect(rows.nth(1)).toContainText("Vessel Songs");
  await expect(rows.first()).toContainText("SMP-031");

  // the title cell opens the entry note — the rest of the row edits (SUB-796)
  await rows.filter({ hasText: "Vessel Songs" }).locator(".embed-view-title").click();
  await expect(page.locator(".note-title")).toHaveValue("Vessel Songs");

  // a fence over an unknown database renders the quiet error card
  await row(page, "Umbra").click();
  await page.locator(".cm-line", { hasText: "Rows open their note" }).click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type("\n```view\ntype: bogus\n```");
  // move below the closing fence: the cursor leaving the block renders it
  await page.keyboard.press("Enter");
  await expect(page.locator(".embed-view")).toHaveCount(2);
  await expect(page.locator(".embed-view-err")).toHaveText("Unknown database “bogus”");

  // SUB-122: an open embed re-snapshots when the vault changes underneath
  // it — a release note with its own fence sits in the db side split while
  // a row's status is edited through the table
  await openDb(page, "Release");
  await page
    .locator(".db-table tbody tr", { hasText: "Vessel Songs" })
    .locator(".db-title")
    .click();
  const side = page.locator(".db-note");
  await expect(side.locator(".note-title")).toHaveValue("Vessel Songs");
  await side.locator(".cm-line").first().click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type("\n```view\ntype: release\n```");
  await page.keyboard.press("Enter");
  const sideEmbed = side.locator(".embed-view");
  const fernRow = sideEmbed.locator("tbody tr", { hasText: "Fern Palace" });
  await expect(sideEmbed).toBeVisible();
  await expect(fernRow.locator("td").nth(1)).toHaveText("mastering");

  await page
    .locator(".db-table tbody tr", { hasText: "Fern Palace" })
    .locator(".db-cell", { hasText: "mastering" })
    .click();
  const statusMenu = page.locator(".selmenu");
  await expect(statusMenu).toBeVisible();
  await statusMenu.locator(".selmenu-item", { hasText: "live" }).click();
  // no navigation happened — the embed rebuilt in place with fresh data
  await expect(side.locator(".note-title")).toHaveValue("Vessel Songs");
  await expect(fernRow.locator("td").nth(1)).toHaveText("live");
});

test("markdown links render styled off the active line, raw on it (SUB-88)", async ({
  page,
}) => {
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");

  await page.locator(".cm-content").click();
  await page.keyboard.type("\n- [Sellpy](https://www.sellpy.fr/) — second-hand clothing");
  // cursor moves onto a fresh line below — the link line leaves the active set
  await page.keyboard.press("Enter");

  const line = page.locator(".cm-line", { hasText: "Sellpy" });
  const link = line.locator(".cm-mdlink");
  await expect(link).toHaveText("Sellpy");
  await expect(link).toHaveAttribute("data-href", "https://www.sellpy.fr/");
  await expect(line).not.toContainText("https://");

  // cursor back into the line → raw syntax revealed
  await page.keyboard.press("ArrowUp");
  await expect(line).toContainText("[Sellpy](https://www.sellpy.fr/)");
});

test("plain notes carry a default Database chip; home-folder ⌘N births typed entries (SUB-125)", async ({
  page,
}) => {
  // a plain note states its kind quietly — Database · note, nothing on disk
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await row(page, "Welcome").click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  const plain = chip(page, "Database");
  await expect(plain.locator(".chip-val")).toHaveText("note");

  // clicking it opens the standard database picker; picking joins for real
  await plain.click();
  const menu = page.locator(".selmenu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".selmenu-listhead")).toHaveText("Databases");
  await menu.locator(".selmenu-item", { hasText: "gear" }).click();
  await expect(chip(page, "Database").locator(".chip-val")).toHaveText("gear");

  // ⌘N inside a database's home folder births that database's entry
  const treeRow = page.locator(".side-folder", {
    has: page.locator(".side-label-text", { hasText: /^Tasks$/ }),
  });
  await treeRow.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Show files" }).click();
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toHaveValue("Untitled");
  await expect(chip(page, "Database").locator(".chip-val")).toHaveText("task");
});

test("code spans/fences render verbatim; quoted lists continue and tasks toggle (SUB-102, SUB-104)", async ({
  page,
}) => {
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  const content = page.locator(".cm-content");
  await content.click();

  // wikilink-shaped text inside inline code and a fence must stay literal
  await page.keyboard.type("\ninline `[[code span]]` stays verbatim");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[[fence link]]");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");

  await expect(page.locator(".cm-codeblock-line")).toHaveCount(3);
  await expect(content).toContainText("[[code span]]");
  await expect(content).toContainText("[[fence link]]");
  await expect(page.locator(".cm-wikilink")).toHaveCount(0);

  // Enter on a quoted list item continues with the same quote + bullet
  await page.keyboard.type("> - quoted item");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line", { hasText: "second" })).toHaveText("> - second");

  // a task inside a blockquote renders its checkbox without leaving the bullet
  await page.keyboard.type("[ ] quoted task body");
  await page.keyboard.press("Enter");
  const quotedTask = page.locator(".cm-line", { hasText: "quoted task body" });
  await expect(quotedTask.locator("input.cm-task-toggle")).toHaveCount(1);
  await expect(quotedTask).toHaveText("> quoted task body");
  await expect(page.locator(".cm-wikilink")).toHaveCount(0);
});

test("[[ inside a code fence stays literal — no popup, Enter is a newline (SUB-652)", async ({
  page,
}) => {
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");

  // documenting markdown syntax: `[[` here is literal text. An empty query
  // ranks every title flat, so an open popup would splice the top match in.
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[[");
  // past autocompletion's interactionDelay (75ms) — inside it CodeMirror
  // ignores Enter anyway, so waiting is what makes the assertion mean anything
  await page.waitForTimeout(120);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);

  await page.keyboard.press("Enter");
  await page.keyboard.type("after");

  // Enter inserted a newline: `[[` and `after` sit on separate fence lines,
  // and no title + `]]` was spliced into either
  const fenceLines = page.locator(".cm-codeblock-line");
  await expect(fenceLines.filter({ hasText: "[[" })).toHaveText("[[");
  await expect(fenceLines.filter({ hasText: "after" })).toHaveText("after");
  await expect(fenceLines.filter({ hasText: "]]" })).toHaveCount(0);
});

test("done tasks strike through at full text color; created chip is human (SUB-148, SUB-144)", async ({
  page,
}) => {
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await page.locator(".cm-content").click();

  await page.keyboard.type("\n- [ ] open thing");
  await page.keyboard.press("Enter");
  // task continuation pre-fills "- [ ] " — type just the body
  await page.keyboard.type("finished thing");
  await page.keyboard.press("Enter");

  const openTask = page.locator(".cm-line", { hasText: "open thing" });
  const doneTask = page.locator(".cm-line", { hasText: "finished thing" });
  // flip it done via the rendered checkbox (exercises the click-toggle path)
  await doneTask.locator("input.cm-task-toggle").click();
  await expect
    .poll(() => doneTask.evaluate((el) => getComputedStyle(el).textDecorationLine))
    .toContain("line-through");
  const openColor = await openTask.evaluate((el) => getComputedStyle(el).color);
  const doneColor = await doneTask.evaluate((el) => getComputedStyle(el).color);
  expect(doneColor).toBe(openColor);

  await expect(chip(page, "created")).toContainText("Jul 17, 2026");
});

test("pasted svg gets a real .svg name and renders as an image (SUB-103)", async ({ page }) => {
  await row(page, "Capture anything").click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  const content = page.locator(".cm-content");
  await content.click();

  // a generic clipboard name forces subtype → extension resolution (svg+xml)
  await page.evaluate(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="#888"/></svg>`;
    const file = new File([svg], "image.svg", { type: "image/svg+xml" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(ev);
  });

  // the insert lands at the cursor, so the embed line starts active (raw
  // source visible) — moving to a fresh line below renders the widget
  await expect(content).toContainText("![[pasted-");
  await page.keyboard.press("Enter");

  // the saved asset name lands on the img alt — it must carry a real .svg
  // extension (a broken subtype mapping would produce .svgxml)
  const img = page.locator(".cm-embed-img img");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("alt", /^pasted-.*\.svg$/);
  await expect(img).toHaveAttribute("src", /^blob:/);
  // actually decoded — a wrong MIME would leave the img broken at width 0
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(12);
});

test("history: diff an older snapshot, restore reverts the body (SUB-121)", async ({ page }) => {
  // Welcome is open from boot — edit it so the restore has something to undo.
  // The marker never gets a newline, so the body's line count (and thus the
  // seeded snapshots' prefix cut) is unchanged
  const marker = `E2E-REVERT ${Date.now()}`;
  await page.locator(".cm-content").click();
  await page.keyboard.type(marker);
  await expect(page.locator(".cm-content")).toContainText(marker);

  // leaving the note flushes the debounced write (NotePane cleanup)
  await row(page, "Capture anything").click();
  await row(page, "Welcome").click();
  await expect(page.locator(".cm-content")).toContainText(marker);

  await page.locator(".note-tool[aria-label=History]").click();
  await expect(page.locator(".hist-item")).toHaveCount(3);

  // the oldest snapshot diffs against its successor — the trimmed-away lines
  // render as deletions
  await page.locator(".hist-item").last().click();
  await expect(page.locator(".hist-line-del").first()).toBeVisible();

  // restore writes the old version back as a NEW snapshot — the list grows
  await page.locator(".hist-restore").click();
  await expect(page.locator(".hist-item")).toHaveCount(4);
  await page.locator(".hist-close").click();

  // the body is back to the oldest version: a first-third prefix, so the
  // middle of the original body is gone but its start remains
  await expect(page.locator(".cm-content")).not.toContainText("Checklists and tables");
  await expect(page.locator(".cm-content")).toContainText("The basics");
});

test("calendar: drag an entry chip to another day reschedules it (SUB-121)", async ({ page }) => {
  await page.locator(".side-item:not(.side-folder)", { hasText: "Calendar" }).click();
  await expect(page.locator(".cal")).toBeVisible();

  // "Umbra listening session" is the mock event dated today
  const source = page.locator(`.cal-day[data-iso="${todayIso()}"]`);

  // Pick the drop target from the cells the grid actually rendered, not from
  // today+N. The month grid renders only the weeks that intersect the month
  // (monthGridDays — "never a dead trailing row"), so a fixed offset falls off
  // the grid near month end: on 2026-07-31 today+3 was Aug 3, past the grid's
  // last cell, and this spec timed out waiting for a cell that never existed
  // (SUB-694 — same trap SUB-547 fixed two tests below). The first cell whose
  // data-iso isn't today always exists: the grid is >= 4 weeks, so there are
  // always >= 27 non-today cells, and it may be a prev-month trailing day,
  // which drops the same way (dayCell wires onDrop for adjacent cells too).
  const targetIso = await page
    .locator(".cal-grid .cal-day")
    .evaluateAll(
      (els, today) =>
        els
          .map((el) => el.getAttribute("data-iso") ?? "")
          .find((iso) => iso && iso !== today) ?? "",
      todayIso()
    );
  expect(targetIso).toBeTruthy();
  const target = page.locator(`.cal-day[data-iso="${targetIso}"]`);
  const entry = source.locator(".cal-entry", { hasText: "Umbra listening session" });
  await expect(entry).toBeVisible();

  await entry.dragTo(target);

  // dropOn rewrites the date prop (vaultSetProp) and the chip re-renders in
  // the target cell
  await expect(
    target.locator(".cal-entry", { hasText: "Umbra listening session" })
  ).toBeVisible();
  await expect(
    source.locator(".cal-entry", { hasText: "Umbra listening session" })
  ).toHaveCount(0);
});

test("calendar recurring event: repeat weekly, skip one occurrence, delete all (SUB-174)", async ({
  page,
}) => {
  await page.locator(".side-item:not(.side-folder)", { hasText: "Calendar" }).click();
  await expect(page.locator(".cal")).toBeVisible();

  // Compose on the grid's FIRST cell, not on today. The month grid renders only
  // the weeks that intersect the month (monthGridDays — "never a dead trailing
  // row"), so anchoring on today puts the next weekly occurrence off-screen
  // whenever today falls in the last week: on 2026-07-27 the grid ended Aug 2
  // and today+7 was Aug 3, so .nth(1) below matched nothing and this spec was
  // red for the last week of the month (SUB-547). Row one is always on screen,
  // and the grid is always >= 4 weeks, so anchor+7 always lands in row two.
  const anchorIso = await page
    .locator(".cal-day")
    .first()
    .evaluate((el) => el.getAttribute("data-iso") ?? "");
  expect(anchorIso).toBeTruthy();
  const anchorCell = page.locator(`.cal-day[data-iso="${anchorIso}"]`);
  await anchorCell.locator(".cal-daynum").click();
  const draft = page.locator(".cal-draft-input");
  await draft.fill("Standup");
  await draft.press("Enter");
  const anchorChip = anchorCell.locator(".cal-entry", { hasText: "Standup" });
  await expect(anchorChip).toBeVisible();

  // right-click → Repeat… → Weekly: the series expands across the month grid
  await anchorChip.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Repeat…" }).click();
  await page.locator(".selmenu-item", { hasText: "Weekly" }).click();
  const chips = page.locator(".cal-grid .cal-entry", { hasText: "Standup" });
  const later = chips.nth(1); // grid order follows the days — the next week
  await expect(later).toBeVisible();
  await expect(later.locator(".cal-entry-repeat")).toBeVisible();

  // right-click a later occurrence → Skip this occurrence: it vanishes, the
  // rest of the series stays
  const iso = await later.evaluate((el) => el.closest(".cal-day")?.getAttribute("data-iso"));
  expect(iso).toBeTruthy();
  await later.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Skip this occurrence" }).click();
  await expect(
    page.locator(`.cal-day[data-iso="${iso}"] .cal-entry`, { hasText: "Standup" })
  ).toHaveCount(0);
  await expect(anchorChip).toBeVisible();

  // Delete all occurrences: the whole series leaves the grid
  await anchorChip.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Delete all occurrences" }).click();
  await expect(page.locator(".cal-grid .cal-entry", { hasText: "Standup" })).toHaveCount(0);
});

test("tray agenda window boots and renders today's mock entries (SUB-121)", async ({ page }) => {
  await page.goto("/agenda.html");
  await expect(page.locator(".agenda-head")).toContainText("Today");

  // today's mock entries: an event by date and a task by its due deadline
  const list = page.locator(".agenda-list");
  await expect(
    list.locator(".agenda-row", { hasText: "Umbra listening session" })
  ).toBeVisible();
  await expect(
    list.locator(".agenda-row", { hasText: "Approve SMP-030 artwork" })
  ).toBeVisible();

  // the overdue count is a floor, not an exact pin (SUB-182): several
  // deadlines sit in the past by design — "Renew Bandcamp plan" is the named
  // fixture, asserted by title on the calendar surface in today.spec.ts
  await expect(page.locator(".agenda-overdue")).toContainText(/^[1-9]\d* overdue$/);
  await expect(page.locator(".agenda-capture")).toBeVisible();
});

test("saved view: the tab strip recalls a pin (SUB-160)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();

  // no pins yet → just the All tab, active
  await expect(page.locator(".db-tab")).toHaveCount(1);
  await expect(page.locator(".db-tab.active")).toHaveText("All");

  // pin a live filter via the filter bar's Save view button
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  let nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  const livePin = page.locator(".side-view", { hasText: "Live releases" });
  await expect(livePin).toHaveCount(1);

  // a second save adds a sibling pin — orphans stay visible (no section to
  // collapse anymore); the homed row auto-expand on save is covered in
  // schemameta.spec
  await page.locator(".db-filter-input").fill("status:mastering ");
  await page.locator(".db-filter-save").click();
  nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Mastering");
  await nameInput.press("Enter");
  await expect(livePin).toHaveCount(1);
  await expect(page.locator(".side-view", { hasText: "Mastering" })).toHaveCount(1);

  // the strip carries All + both pins; clicking a tab recalls its view —
  // the db title stays the database's, the pin's name rides the active tab
  const tabs = page.locator(".db-tab");
  await expect(tabs).toHaveCount(3);
  await tabs.filter({ hasText: "Live releases" }).click();
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-filter-input")).toHaveValue("status:live");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);

  // inside the pin, its tab carries the active mark
  const activeTab = page.locator(".db-tab.active");
  await expect(activeTab).toHaveCount(1);
  await expect(activeTab).toHaveText("Live releases⌘5");

  // right-click on a tab surfaces the pin's manage menu (Open/Rename/Remove)
  await tabs.filter({ hasText: "Mastering" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Rename…" })).toHaveCount(1);
  await expect(page.locator(".ctx-item", { hasText: "Remove pin" })).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("saved view: per-view display columns curate table + list, recalled by the pin (SUB-212)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table")).toBeVisible();
  // the full union: Name + 10 data columns + the add-property cell
  await expect(page.locator(".db-table thead th")).toHaveCount(12);

  // the Columns curator lists the union, everything checked
  const colsBtn = page.locator(".db-cols-btn");
  await expect(colsBtn).toBeVisible();
  await colsBtn.click();
  const menu = page.locator(".db-cols-menu");
  await expect(menu.locator(".db-cols-item")).toHaveCount(10);
  // SUB-945: the curator uses the same check control as the property
  // checklist, so "shown" is the pressed state, not a ✓ glued to the label
  await expect(menu.locator('.db-cols-item[aria-pressed="true"]')).toHaveCount(10);

  // unchecking re-renders immediately (menu stays open for multi-toggle)
  await menu.locator(".db-cols-item", { hasText: "cat#" }).click();
  await expect(page.locator(".db-table thead th")).toHaveCount(11);
  await expect(page.locator(".db-table thead th", { hasText: "cat#" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // SUB-326: persistent on a plain database — leave and return, still hidden
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openDb(page, "Release");
  await expect(page.locator(".db-table thead th")).toHaveCount(11);
  await expect(page.locator(".db-table thead th", { hasText: "cat#" })).toHaveCount(0);

  // curate further and pin it — the Save view flow captures the selection
  await colsBtn.click();
  await menu.locator(".db-cols-item", { hasText: "artist" }).click();
  await page.keyboard.press("Escape");
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Curated");
  await nameInput.press("Enter");
  const pin = page.locator(".side-view", { hasText: "Curated" });
  await expect(pin).toHaveCount(1);

  // recall through the pin: exactly the curated set, in every layout
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await pin.click();
  await expect(page.locator(".list-title")).toHaveText("Release");
  await expect(page.locator(".db-tab.active")).toHaveText("Curated⌘5");
  await expect(page.locator(".db-table thead th")).toHaveCount(10);
  await expect(page.locator(".db-table thead th", { hasText: "cat#" })).toHaveCount(0);
  await expect(page.locator(".db-table thead th", { hasText: "artist" })).toHaveCount(0);
  await expect(page.locator(".db-table thead th", { hasText: "status" })).toHaveCount(1);

  // the curator inside the pin reflects the persisted selection
  await colsBtn.click();
  await expect(menu.locator('.db-cols-item[aria-pressed="true"]')).toHaveCount(8);
  await expect(menu.locator(".db-cols-item", { hasText: "cat#" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(menu.locator(".db-cols-item", { hasText: "status" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.keyboard.press("Escape");

  // list layout: the subtitle follows the curated columns too
  await page.locator(".db-switch button[title=\"List\"]").click();
  const row = page.locator(".db-list .row", { hasText: "Slow Bloom EP" });
  await expect(row.locator(".row-sub")).toContainText("in review");
  await expect(row.locator(".row-sub")).not.toContainText("SMP-030");
  await expect(row.locator(".row-sub")).not.toContainText("various");
});
