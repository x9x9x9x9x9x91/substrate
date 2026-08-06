import { expect, test, type Page } from "@playwright/test";

// Tag folders — a saved tag rule that sits inline with the real
// folders and ACCEPTS WORK. Building one is chips + any/all + "but not …",
// never a query language; acting inside one writes the folder's tags onto the
// note and nothing moves on disk.
//
// The mock boots with no tag folders and no tagged notes, which is the real
// "first tag folder" state — so each spec seeds the tags it needs through
// __mockEditNote/__mockEditProp (an editor outside the app) rather than
// leaning on shared fixtures other suites pin.

/** Seed tags onto mock notes the way an outside writer would, then let the
    app re-read the index. The 1.1 s wait clears the own-write echo window
    so the refetch runs immediately, same as undoclobber. */
async function seed(page: Page, edits: { path: string; body?: string; tags?: string[] }[]) {
  await page.evaluate((es) => {
    for (const e of es) {
      if (e.body !== undefined) window.__mockEditNote!(e.path, e.body);
      if (e.tags !== undefined) window.__mockEditProp!(e.path, "tags", e.tags);
    }
  }, edits);
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));
}

/** Drive the builder: sidebar "+" → New tag folder… → chips → save. */
async function buildTagFolder(
  page: Page,
  opts: { name: string; tags: string[]; match?: "any" | "all"; exclude?: string[] }
) {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New tag folder…" }).click();

  const dialog = page.getByRole("dialog", { name: "New tag folder" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Folder name").fill(opts.name);

  const tagged = dialog.getByLabel("Tagged");
  for (const t of opts.tags) {
    await tagged.fill(t);
    await tagged.press("Enter");
  }
  if (opts.match === "all") {
    await dialog.getByRole("radio", { name: "All of them" }).click();
  }
  for (const t of opts.exclude ?? []) {
    const not = dialog.getByLabel("But not");
    await not.fill(t);
    await not.press("Enter");
  }
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await expect(dialog).toHaveCount(0);
}

/** Rows are matched by path, not text: Playwright's `hasText` folds case, and
    a row's prop subtext can quote another note's title. */
function row(page: Page, path: string) {
  return page.locator(`.list-body .row[data-path="${path}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("the builder makes a tag folder that lands inline in the sidebar (SUB-818)", async ({
  page,
}) => {
  // #demo lives in prose, #live in the tags: prop — the union is the point
  await seed(page, [
    { path: "Glass Havens.md", body: "Second pressing shipped. #demo #live\n" },
    { path: "Fern Palace.md", body: "Artwork proofs due Friday. #demo\n" },
    { path: "Static Bouquet.md", tags: ["live"] },
  ]);

  await buildTagFolder(page, { name: "Demos", tags: ["demo"] });

  // the row sits among the real folders, wearing the tag glyph — not in a
  // separate "smart" section
  const side = page.locator("[data-tagfolder]");
  await expect(side).toHaveCount(1);
  await expect(side).toHaveClass(/side-folder/);
  await expect(side.locator("svg.type-icon")).toBeVisible();
  await expect(side.getByRole("button", { name: "Demos" })).toBeVisible();

  // saving opens it: header names the kind, and only the #demo notes are in
  await expect(page.locator(".list-title")).toHaveText("Demos");
  await expect(page.locator(".head-kind")).toHaveText("Tag folder");
  const rows = page.locator(".list-body .row:not(.row-dbblock)");
  await expect(rows).toHaveCount(2);
  await expect(row(page, "Glass Havens.md")).toHaveCount(1);
  await expect(row(page, "Fern Palace.md")).toHaveCount(1);
  await expect(row(page, "Static Bouquet.md")).toHaveCount(0);
});

test("all-of-them plus an exclusion narrows the collection (SUB-818)", async ({ page }) => {
  await seed(page, [
    { path: "Glass Havens.md", body: "Second pressing. #demo #live\n" },
    { path: "Fern Palace.md", body: "Proofs due. #demo #live #wip\n" },
    { path: "Static Bouquet.md", body: "Notes. #demo\n" },
  ]);

  await buildTagFolder(page, {
    name: "Ready",
    tags: ["demo", "live"],
    match: "all",
    exclude: ["wip"],
  });

  // #demo AND #live, but not #wip — Fern Palace is excluded, Static Bouquet
  // never had #live
  const rows = page.locator(".list-body .row:not(.row-dbblock)");
  await expect(rows).toHaveCount(1);
  await expect(row(page, "Glass Havens.md")).toHaveCount(1);

  // the rule is spelled out in words on the row, never as a query
  await expect(page.locator("[data-tagfolder] .side-destination")).toHaveAttribute(
    "data-tip",
    "#demo and #live, but not #wip"
  );
});

test("creating inside a tag folder tags the note and moves nothing (SUB-818)", async ({ page }) => {
  await seed(page, [{ path: "Glass Havens.md", body: "Second pressing. #demo\n" }]);
  await buildTagFolder(page, { name: "Demos", tags: ["demo"], exclude: ["wip"] });

  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toHaveValue("Untitled");

  // the scratch is born where loose notes are born, wearing the folder's
  // POSITIVE tags only — an exclusion would file it straight back out
  const tags = await page.evaluate(() => window.__mockPropOf!("Inbox/Untitled.md", "tags"));
  expect(tags).toEqual(["demo"]);

  // and it's in view without having moved anywhere special
  await expect(page.locator(".list-title")).toHaveText("Demos");
  await expect(
    row(page, "Inbox/Untitled.md")
  ).toHaveCount(1);
});

test("dropping a note on a tag folder tags it in place (SUB-818)", async ({ page }) => {
  await seed(page, [{ path: "Glass Havens.md", body: "Second pressing. #demo\n" }]);
  await buildTagFolder(page, { name: "Demos", tags: ["demo", "queued"], exclude: ["wip"] });

  // drag from a plain folder view, so the source path is known and stable
  await page.locator(".side-folder", { hasText: "Ideas" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Ideas");
  const dragged = page.locator(".list-body .row:not(.row-dbblock)").first();
  const path = await dragged.getAttribute("data-path");
  expect(path).toBeTruthy();

  await dragged.dragTo(page.locator("[data-tagfolder]"));

  // both positive tags land; the exclusion does not; the file never moved
  await expect
    .poll(() => page.evaluate((p) => window.__mockPropOf!(p!, "tags"), path))
    .toEqual(["demo", "queued"]);
  expect(await page.evaluate((p) => window.__mockBodyOf!(p!) !== undefined, path)).toBe(true);

  await page.locator("[data-tagfolder] .side-destination").click();
  await expect(page.locator(".head-kind")).toHaveText("Tag folder");
});

test("undo takes back a drag-in tagging and keeps the tags it didn't add (SUB-1025)", async ({
  page,
}) => {
  await seed(page, [{ path: "Glass Havens.md", body: "Second pressing.\n" }]);
  await buildTagFolder(page, { name: "Demos", tags: ["demo", "queued"] });

  await page.locator(".side-folder", { hasText: "Ideas" }).first().click();
  await expect(page.locator(".list-title")).toHaveText("Ideas");
  const dragged = page.locator(".list-body .row:not(.row-dbblock)").first();
  const path = await dragged.getAttribute("data-path");
  expect(path).toBeTruthy();
  // the note already carries one of the folder's tags — undo must leave it
  await seed(page, [{ path: path!, tags: ["demo", "keep"] }]);

  await dragged.dragTo(page.locator("[data-tagfolder]"));
  await expect
    .poll(() => page.evaluate((p) => window.__mockPropOf!(p!, "tags"), path))
    .toEqual(["demo", "keep", "queued"]);

  await page.keyboard.press("Meta+z");
  await expect
    .poll(() => page.evaluate((p) => window.__mockPropOf!(p!, "tags"), path))
    .toEqual(["demo", "keep"]);
});

test("the builder says why a chip was refused instead of just clearing (SUB-1025)", async ({
  page,
}) => {
  await page.locator(".side-add").click();
  await page.locator(".ctx-item", { hasText: "New tag folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "New tag folder" });

  const tagged = dialog.getByLabel("Tagged");
  await tagged.fill("#2024");
  await tagged.press("Enter");

  // the hint names the grammar, the draft survives so it can be fixed, and
  // no chip appeared
  await expect(dialog.locator(".tagfolder-reject")).toContainText("start with a letter");
  await expect(tagged).toHaveValue("#2024");
  await expect(dialog.locator(".tagfolder-chip")).toHaveCount(0);

  // a duplicate is refused in its own words
  await tagged.fill("demo");
  await tagged.press("Enter");
  await expect(dialog.locator(".tagfolder-chip")).toHaveCount(1);
  await expect(dialog.locator(".tagfolder-reject")).toHaveCount(0);
  await tagged.fill("DEMO");
  await tagged.press("Enter");
  await expect(dialog.locator(".tagfolder-reject")).toContainText("already here");

  // valid input still adds, and the hint clears
  await tagged.fill("live");
  await tagged.press("Enter");
  await expect(dialog.locator(".tagfolder-chip")).toHaveCount(2);
  await expect(dialog.locator(".tagfolder-reject")).toHaveCount(0);
});
