import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// A bulk edit that half-lands has to say WHICH notes it couldn't
// write and why. The toast can only carry a count — "1 failed" out of 2 is
// survivable, out of 40 it names nothing — so the refused notes become the
// selection and each one wears its own reason.
//
// __mockFailOnce refuses only the NEXT vault_set_prop, and the bulk writes are
// sequential, so exactly the first note of the selection is refused: a partial
// failure, which a plain __mockFail (every call, forever) can never produce.

async function openContacts(page: Page) {
  await page.goto("/");
  await openDb(page, "Contact");
}

function row(page: Page, title: string) {
  return page.locator(".db-table tbody tr", { hasText: title });
}

function titleCell(page: Page, title: string) {
  return row(page, title).locator(".db-title");
}

/** ⌘-click Annelies then Gero and set role → booking, with the first write
    refused. Annelies is first in click order, so Annelies is the failure. */
async function bulkSetWithOneRefusal(page: Page) {
  await titleCell(page, "Annelies").click({ modifiers: ["Meta"] });
  await titleCell(page, "Gero").click({ modifiers: ["Meta"] });
  await page.evaluate(() => window.__mockFailOnce!("vault_set_prop"));
  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "role" }).click();
  await page.locator(".selmenu-item", { hasText: "booking" }).click();
}

test("a partly-refused bulk edit leaves the failed note selected, marked and reasoned", async ({
  page,
}) => {
  await openContacts(page);
  await bulkSetWithOneRefusal(page);

  // the toast's grammar is unchanged — it still reports the count
  await expect(page.locator(".toast")).toContainText("Set 1 of 2 — 1 failed");
  // the write that landed, landed; the refused one rolled back to its own value
  await expect(row(page, "Gero")).toContainText("booking");
  await expect(row(page, "Annelies")).not.toContainText("booking");

  // …and the selection is now exactly the note that didn't take the write, so
  // the bar counts the failures rather than leaving a silently smaller count
  await expect(page.locator("tr.is-selected")).toHaveCount(1);
  await expect(row(page, "Annelies")).toHaveClass(/is-selected/);
  await expect(page.locator(".bulkbar")).toContainText("1 didn’t save");

  // the reason lives on the row it happened to, readable without a pointer
  const mark = row(page, "Annelies").locator(".db-fail");
  await expect(mark).toHaveCount(1);
  await expect(page.locator(".db-fail")).toHaveCount(1);
  await expect(mark).toHaveAttribute("title", /Not saved —.*mock failure: vault_set_prop/);
  await expect(mark).toHaveAttribute("aria-label", /Not saved —.*mock failure: vault_set_prop/);
});

test("the narrowed selection retries the same edit, and the mark goes with it", async ({
  page,
}) => {
  await openContacts(page);
  await bulkSetWithOneRefusal(page);
  await expect(page.locator(".db-fail")).toHaveCount(1);

  // the bulk bar came back holding exactly the note that still needs the edit,
  // so the same edit runs again on exactly it — this time nothing refuses
  await page.locator(".bulkbar button", { hasText: "Set property…" }).click();
  await page.locator(".colmenu .dots-item", { hasText: "role" }).click();
  await page.locator(".selmenu-item", { hasText: "booking" }).click();

  await expect(row(page, "Annelies")).toContainText("booking");
  await expect(page.locator(".toast")).toContainText("on 1 note");
  // nothing is left over: no mark, and the write consumed the selection
  await expect(page.locator(".db-fail")).toHaveCount(0);
  await expect(page.locator(".bulkbar")).toHaveCount(0);
});

test("dismissing the selection dismisses the marks", async ({ page }) => {
  await openContacts(page);
  await bulkSetWithOneRefusal(page);
  await expect(page.locator(".db-fail")).toHaveCount(1);

  // Escape is how the user says "seen it" — no mark may outlive the selection
  // it narrowed
  await page.keyboard.press("Escape");
  await expect(page.locator(".bulkbar")).toHaveCount(0);
  await expect(page.locator(".db-fail")).toHaveCount(0);
});
