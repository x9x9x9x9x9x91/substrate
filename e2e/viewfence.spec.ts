import { expect, test, type Page } from "./fixtures";
import { openFilter } from "./nav";

// A ```view fence teaches itself. `type:` completed from live database
// names already; now the fence's KEYS complete on a fresh line (⌃Space, the
// keys it doesn't already carry) and the values that name vault vocabulary —
// `saved:`, `sort:`, `columns:`, `query:` — complete from the database behind
// the fence. The saved-view pin closes the loop: its menu writes the fence
// that embeds it, so a pin reaches a note without anyone typing YAML.

const menu = ".cm-tooltip-autocomplete";
const selected = `${menu} li[aria-selected="true"]`;

/** Wait for `label` to be the selected option, then Enter to accept it. Same
    75ms interactionDelay dance as e2e/slashmenu.spec.ts. */
async function accept(page: Page, label: string) {
  await expect(page.locator(selected)).toContainText(label);
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
}

/** Open the Inbox note and land the cursor on a fresh last line. */
async function openScratchNote(page: Page) {
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Capture anything");
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  const lines = page.locator(".cm-line");
  const before = await lines.count();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(lines).toHaveCount(before + 1);
}

/** `/view` + a database, stopping INSIDE the fence: Escape dismisses the type
    picker so the name is typed rather than accepted (accepting it steps the
    cursor out past the closing line). */
async function fenceOnRelease(page: Page) {
  await page.keyboard.type("/view");
  await accept(page, "/view");
  await expect(page.locator(".cm-content")).toContainText("type:");
  await page.keyboard.press("Escape");
  await page.keyboard.type("release");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("a fresh line inside the fence completes its keys, minus the ones in use", async ({
  page,
}) => {
  await openScratchNote(page);
  await fenceOnRelease(page);

  // Enter alone means newline inside a fence — the key list is explicit
  await expect(page.locator(menu)).toHaveCount(0);
  await page.keyboard.press("Control+Space");
  await expect(page.locator(menu)).toBeVisible();
  const options = page.locator(`${menu} li`);
  await expect(options.filter({ hasText: "sort" })).toHaveCount(1);
  await expect(options.filter({ hasText: "columns" })).toHaveCount(1);
  await expect(options.filter({ hasText: "query" })).toHaveCount(1);
  // `type:` is already on the fence above — a key can only be said once
  await expect(options.filter({ hasText: /^type/ })).toHaveCount(0);

  // accepting a key writes `key: ` and opens the value list in one step
  await page.keyboard.type("so");
  await accept(page, "sort");
  await expect(page.locator(".cm-content")).toContainText("sort:");
  await expect(page.locator(menu)).toBeVisible();
});

test("sort: completes the database's own props, then asc/desc after the colon", async ({
  page,
}) => {
  await openScratchNote(page);
  await fenceOnRelease(page);
  await page.keyboard.press("Control+Space");
  await page.keyboard.type("sort");
  await accept(page, "sort");

  // the props on offer are Release's, because the fence says so
  await expect(page.locator(`${menu} li`).filter({ hasText: "status" })).toHaveCount(1);
  await page.keyboard.type("stat");
  await accept(page, "status");

  // `prop:asc` — the direction is its own little vocabulary
  await page.keyboard.type(":");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(`${menu} li`).filter({ hasText: "desc" })).toHaveCount(1);
  await page.keyboard.type("de");
  await accept(page, "desc");
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf!("Inbox/Capture anything.md")))
    .toContain("sort: status:desc");
});

test("a saved-view pin embeds itself into the open note", async ({ page }) => {
  // seed a pin through the app's own save flow, from the database view
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "Live releases" })).toHaveCount(1);

  await openScratchNote(page);
  await page.locator(".side-view", { hasText: "Live releases" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Embed in this note" }).click();

  // the fence lands in the body by NAME (readable, and it survives a rename
  // of nothing else) and renders on the spot
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf!("Inbox/Capture anything.md")))
    .toContain("```view\nsaved: Live releases\n```");
  await expect(page.locator(".embed-view")).toBeVisible();
});

test("a fence that names its pin by id completes just as well as one naming it", async ({
  page,
}) => {
  // a pin whose name carries a `:` can't be named in `key: value` fence text,
  // so the embed references it by ID — and an id-form fence must still know
  // which database its other lines complete from
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live: releases");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "Live: releases" })).toHaveCount(1);

  await openScratchNote(page);
  await page.locator(".side-view", { hasText: "Live: releases" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Embed in this note" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf!("Inbox/Capture anything.md")))
    .toMatch(/```view\nsaved: \S+\n```/);
  const body = await page.evaluate(() => window.__mockBodyOf!("Inbox/Capture anything.md"));
  expect(body).not.toContain("saved: Live: releases");

  // back into the fence's source: the closer, then the `saved:` line
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Space");
  await page.keyboard.type("sort");
  await accept(page, "sort");
  // Release's own props, reached through the pin's id
  await expect(page.locator(`${menu} li`).filter({ hasText: "status" }).first()).toBeVisible();
});

test("query: offers only what a filter term can name — the joins stay out", async ({ page }) => {
  await openScratchNote(page);
  await fenceOnRelease(page);

  // `sort:` resolves a one-hop join itself, so the joins belong in ITS list
  await page.keyboard.press("Control+Space");
  await page.keyboard.type("sort");
  await accept(page, "sort");
  const options = page.locator(`${menu} li`);
  await expect(options.filter({ hasText: "via contact" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");

  // `query:` filters on the row's own props, so a join term would match
  // nothing — it isn't offered
  await page.keyboard.press("Control+Space");
  await page.keyboard.type("query");
  await accept(page, "query");
  await expect(page.locator(menu)).toBeVisible();
  await expect(options.filter({ hasText: "status" }).first()).toBeVisible();
  await expect(options.filter({ hasText: "via " })).toHaveCount(0);
  await expect(options.filter({ hasText: "contact." })).toHaveCount(0);
});

test("a join typed into query: by hand matches nothing — the trap that list avoids", async ({
  page,
}) => {
  await openScratchNote(page);
  await fenceOnRelease(page);
  // `contact` IS a release prop and Gero IS that contact's email, so this
  // reads like it should work — the filter path resolves own props only
  await page.keyboard.type("query: contact.email:gero@umbra.example");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf!("Inbox/Capture anything.md")))
    .toContain("query: contact.email:gero@umbra.example");
  // out of the fence, so the widget renders instead of its source
  await page.locator(".note-title").click();
  await expect(page.locator(".embed-view-more")).toHaveText("No matching rows");
});

test('the pin menu offers the clipboard when no note pane holds the cursor', async ({ page }) => {
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");

  // a note HAS been open — but the database view owns the screen now, and its
  // pane is not the one that would receive the insert
  await openScratchNote(page);
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".side-view", { hasText: "Live releases" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Copy embed fence" })).toBeVisible();
  await expect(page.locator(".ctx-item", { hasText: "Embed in this note" })).toHaveCount(0);
});

// Evidence run for the visual self-check — not a gate:
//   SHOTS=/tmp/shots npx playwright test e2e/viewfence.spec.ts -g shot
test("shot: the key popup, the value popup, and the embedded pin", async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  const dir = process.env.SHOTS ?? "";
  await openScratchNote(page);
  await page.keyboard.type("/view");
  await accept(page, "/view");
  await page.screenshot({ path: `${dir}/1-before-type-picker.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.type("release");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${dir}/2-key-popup.png` });
  await page.keyboard.type("sort");
  await accept(page, "sort");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${dir}/3-value-popup.png` });

  // the same universe one slot over: `query:` drops the join rows `sort:`
  // shows, because a filter term can't name them
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Space");
  await page.keyboard.type("query");
  await accept(page, "query");
  await expect(page.locator(menu)).toBeVisible();
  await page.screenshot({ path: `${dir}/7-query-popup.png` });
});

test("shot: the pin menu's embed verb, before and after", async ({ page }) => {
  test.skip(!process.env.SHOTS, "evidence run only");
  const dir = process.env.SHOTS ?? "";
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".dbmgr-row", { hasText: "Release" }).click();
  await (await openFilter(page)).fill("status:live ");
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Live releases");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "Live releases" })).toHaveCount(1);

  await openScratchNote(page);
  await page.screenshot({ path: `${dir}/4-before-note.png` });
  await page.locator(".side-view", { hasText: "Live releases" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Embed in this note" })).toBeVisible();
  await page.waitForTimeout(300); // past the menu's fade-in, so the shot is legible
  await page.screenshot({ path: `${dir}/5-pin-menu.png` });
  await page.locator(".ctx-item", { hasText: "Embed in this note" }).click();
  await expect(page.locator(".embed-view")).toBeVisible();
  await page.screenshot({ path: `${dir}/6-after-embedded.png` });

  // and the same menu where no note pane would receive the insert
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.locator(".side-view", { hasText: "Live releases" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Copy embed fence" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/8-pin-menu-no-note.png` });
});
