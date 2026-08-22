import { expect, test, type Page } from "@playwright/test";
import { openDb } from "./nav";

// Slice 1: property edits are on the app's undo stack (docs/undo.md
// §6.1, tests 14–17). Every surface writes through setPropUndoable, so ⌘Z
// takes back the last property edit — and refuses to when the note changed
// on disk underneath it, rather than clobbering the other writer.

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

/** the data-column index of a prop, read off the table header (title first) —
    headers render display-capitalized, so match case-insensitively */
async function colIndex(page: Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

function chip(page: Page, key: string) {
  return page.locator(".chip").filter({ has: page.locator(".chip-key", { hasText: key }) });
}

// 14
test("a select cell edit is one ⌘Z away, on screen and on disk", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const role = await colIndex(page, "role");
  const cell = () => row(page, "Gero").locator("td").nth(role);
  await expect(cell()).toHaveText("mix engineer");

  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(page.locator(".selmenu")).toHaveCount(0);
  await expect(cell()).toHaveText("booking");

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Role → booking");
  await expect(cell()).toHaveText("mix engineer");

  // and on disk: open the note, whose props are re-read from the store
  await row(page, "Gero").locator(".db-title").dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Gero");
  await expect(chip(page, "role").locator(".chip-val")).toHaveText("mix engineer");
});

// 15
test("a bulk write over 3 rows reverts in one keystroke", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const role = await colIndex(page, "role");
  const cellOf = (title: string) => row(page, title).locator("td").nth(role);
  await expect(cellOf("Gero")).toHaveText("mix engineer");
  await expect(cellOf("Noa")).toHaveText("artwork");
  await expect(cellOf("Annelies")).toHaveText("radio plugger");

  for (const t of ["Gero", "Noa", "Annelies"])
    await row(page, t).locator(".db-title").click({ modifiers: ["Meta"] });
  await expect(page.locator(".bulkbar")).toContainText("3 selected");
  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "role" }).click();
  await page.locator(".selmenu-item", { hasText: "booking" }).click();
  for (const t of ["Gero", "Noa", "Annelies"]) await expect(cellOf(t)).toHaveText("booking");

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("3 notes");
  await expect(cellOf("Gero")).toHaveText("mix engineer");
  await expect(cellOf("Noa")).toHaveText("artwork");
  await expect(cellOf("Annelies")).toHaveText("radio plugger");
});

// 16 — the pattern at property granularity
test("⌘Z refuses after an external change and the outside value survives", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const role = await colIndex(page, "role");
  const cell = () => row(page, "Gero").locator("td").nth(role);

  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell()).toHaveText("booking");

  // someone else rewrites that same property; wait out the own-write echo
  // window so the change reads as external, not as our own echo
  await page.evaluate(() => window.__mockEditProp!("Gero.md", "role", "radio plugger"));
  await page.waitForTimeout(1100);
  await page.evaluate(() => window.__mockEmit!("vault:changed"));
  await expect(cell()).toHaveText("radio plugger");

  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("changed on disk");
  await expect(cell()).toHaveText("radio plugger");
});

// 16b — a non-conflict failure must not jam the stack
test("an inverse that fails outright is skipped, not retried forever", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const role = await colIndex(page, "role");
  const cell = (title: string) => row(page, title).locator("td").nth(role);

  // two property edits, oldest first — the second one's inverse will fail
  await cell("Noa").click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell("Noa")).toHaveText("booking");
  await cell("Gero").click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell("Gero")).toHaveText("booking");

  // the write itself breaks — not a conflict, just a failing backend
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_set_prop"]);
  });
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undo failed");
  await expect(cell("Gero")).toHaveText("booking");

  // backend healthy again: the next ⌘Z must reach the edit BELOW the dead one
  // rather than hammering the entry that already proved it can't run
  await page.evaluate(() => window.__mockFail!.clear());
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".toast")).toContainText("Undid Role → booking");
  await expect(cell("Noa")).toHaveText("artwork");
  await expect(cell("Gero")).toHaveText("booking", "the failed entry stayed failed");
});

// 17
test("⌘Z in the editor undoes text, not the last property edit", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  const role = await colIndex(page, "role");
  const cell = () => row(page, "Gero").locator("td").nth(role);

  await cell().click();
  await page.locator(".selmenu .selmenu-item", { hasText: "booking" }).click();
  await expect(cell()).toHaveText("booking");

  // into the note's body, type, then ⌘Z with the caret in CodeMirror
  await row(page, "Gero").locator(".db-title").dblclick();
  await expect(page.locator(".note-title")).toHaveValue("Gero");
  const ed = page.locator(".cm-content");
  await ed.click();
  await page.keyboard.type("TYPED-477");
  await expect(ed).toContainText("TYPED-477");
  // ControlOrMeta: this is the one press in the file CodeMirror must own, and
  // its `Mod-` binds to Ctrl off macOS. The app's own undo takes either
  // modifier, so every other Meta+z above stays as written.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(ed).not.toContainText("TYPED-477");

  // the property edit is untouched — CodeMirror owned that keystroke
  await expect(chip(page, "role").locator(".chip-val")).toHaveText("booking");
  await expect(page.locator(".toast")).toHaveCount(0);
});
