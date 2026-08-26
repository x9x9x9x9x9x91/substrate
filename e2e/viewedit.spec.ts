import { expect, test, type Page } from "./fixtures";

// Editable inline database views: the ```view fence stopped being a
// read-only snapshot. A non-title cell click opens the same picker the database
// pane opens, the write lands through the same undoable path, and "+ New"
// creates a row seeded from the fence's own query. The title cell and the
// header keep their usual meanings — open the note, open the database.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function openUmbra(page: Page) {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Projects" }).click();
  await row(page, "Umbra").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");
  await expect(page.locator(".embed-view")).toBeVisible();
}

/** a row of the rendered embed, by its title cell */
function embedRow(page: Page, title: string) {
  return page.locator(".embed-view-table tbody tr[data-path]", {
    has: page.locator(".embed-view-title", { hasText: title }),
  });
}

function cell(page: Page, title: string, column: string) {
  return embedRow(page, title).locator(`td[data-column="${column}"]`);
}

/** Move focus off CodeMirror before ⌘Z. The app's prop-undo is surface-scoped
    and deliberately inert while the caret is in a typing surface — with focus
    in the editor the keystroke is CodeMirror's text undo instead
    (e2e/undo-props.spec.ts, "⌘Z in the editor undoes text"). Clicking the row
    of the note already open navigates nowhere; it only moves focus. */
async function leaveEditor(page: Page) {
  await row(page, "Umbra").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");
}

test("a text cell edits in place and the write is undoable (SUB-796)", async ({ page }) => {
  await openUmbra(page);

  // `artist` is inside the column cap and outside the fence's `status:mastering`
  // filter — editing it must not drop the row out of the table being edited
  const target = cell(page, "Fern Palace", "artist");
  await expect(target).toHaveText("glass havens");
  await target.click();

  // the same in-cell editor the database pane opens: prefilled with
  // the raw value, Enter commits
  const menu = page.locator(".selmenu");
  await expect(menu).toHaveClass(/selmenu-cell/);
  const input = menu.locator(".selmenu-input");
  await expect(input).toHaveValue("glass havens");
  await input.fill("fern collective");
  await input.press("Enter");
  await expect(menu).toHaveCount(0);

  // the note on disk carries it, and the widget repainted around the change
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Fern Palace.md", "artist")))
    .toBe("fern collective");
  await expect(cell(page, "Fern Palace", "artist")).toHaveText("fern collective");

  // and it landed in the app's prop-undo stack, not some inline-only mechanism
  await leaveEditor(page);
  await page.keyboard.press("Meta+z");
  // "Artist", capitalized — the same keyLabel the database pane's toast uses
  await expect(page.locator(".toast")).toContainText("Undid Artist → fern collective");
  await expect(cell(page, "Fern Palace", "artist")).toHaveText("glass havens");
});

test("a checkbox cell toggles on the click, without opening a picker", async ({ page }) => {
  await page.goto("/");
  // the release db's checkbox-free schema is the point here, so give `event` a
  // checkbox instead: its column set is small enough that the new prop lands
  // inside the widget's 4-column cap (created, date, done, location)
  await page.evaluate(() => {
    window.__mockEditSchema!("event", {
      date: { options: [], kind: "date" },
      location: { options: [] },
      done: { options: [], kind: "checkbox" },
    });
    window.__mockEmit!("vault:config-changed");
  });

  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/view");
  await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected="true"]')).toContainText(
    "/view"
  );
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
  await page.keyboard.type("eve");
  await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected="true"]')).toContainText(
    "event"
  );
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");

  await expect(page.locator(".embed-view")).toBeVisible();
  const box = cell(page, "Call with Gero", "done").locator(".prop-check");
  // the whole cell is the affordance and nothing is checked yet
  await expect(box).toHaveCount(1);
  await expect(box).not.toHaveClass(/\bon\b/);

  await cell(page, "Call with Gero", "done").click();
  // no picker: a checkbox is its own editor
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell(page, "Call with Gero", "done").locator(".prop-check")).toHaveClass(/\bon\b/);
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Calendar/Call with Gero.md", "done")))
    .toBe(true);
});

test('"+ New" creates a row of the fence\'s type, seeded from its query', async ({ page }) => {
  await openUmbra(page);
  const embed = page.locator(".embed-view");
  await expect(embed.locator(".embed-view-count")).toHaveText("2");

  await embed.locator(".embed-view-new").click();

  // the fence says `status:mastering`, so the new row matches the table it was
  // created from instead of being filtered straight back out of it
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Untitled.md", "status")))
    .toBe("mastering");
  await expect(page.evaluate(() => window.__mockPropOf!("Untitled.md", "type"))).resolves.toBe(
    "release"
  );
  await expect(embed.locator(".embed-view-count")).toHaveText("3");
  await expect(embedRow(page, "Untitled")).toHaveCount(1);
});

test("an open cell editor survives a vault change underneath it", async ({ page }) => {
  await openUmbra(page);

  await cell(page, "Vessel Songs", "artist").click();
  const input = page.locator(".selmenu .selmenu-input");
  await input.fill("half typed");

  // someone else edits a different note in this table. The widget's identity
  // carries the vault epoch, so this rebuilds it — the open editor and the
  // in-progress value have to come through that
  await page.evaluate(() =>
    window.__mockEditProp!("Fern Palace.md", "artist", "outside writer")
  );
  // past the own-write echo window, or the event reads as ours
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));

  await expect(cell(page, "Fern Palace", "artist")).toHaveText("outside writer");
  await expect(page.locator(".selmenu")).toHaveCount(1);
  await expect(input).toHaveValue("half typed");

  // and it still commits to the cell it was opened on
  await input.press("Enter");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__mockPropOf!("Vessel Songs.md", "artist")))
    .toBe("half typed");
});
