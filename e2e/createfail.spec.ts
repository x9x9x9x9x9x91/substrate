import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// A create the engine refuses used to clear the draft and say
// nothing — the row never appeared, no toast, only a console line the user
// can't see. The database draft row, the relation picker's inline create and
// the calendar's day draft all ended on `.catch(console.error)`; each now
// reports on App's toast the way the cell writes have.
//
// `window.__mockFail` makes the mock reject the named command, which is the
// same rejection shape `Engine::create_full` produces for a refused title
// (vault.rs:791 — `[`/`]` are illegal) or an unwritable folder.

test("a refused entry create surfaces on the toast (SUB-564)", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_create"]);
  });

  await page.locator(".db-new").click();
  const draft = page.locator(".db-draft-input");
  await draft.fill("Marta Iversen");
  await draft.press("Enter");

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn’t create “Marta Iversen”");
  await expect(toast).toContainText("mock failure: vault_create");
});

test("a refused calendar day create surfaces on the toast (SUB-564)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cal-grid.month")).toBeVisible();
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_create"]);
  });

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const today = page.locator(`.cal-day[data-iso="${iso}"]`);
  await today.locator(".cal-daynum").click();
  const draft = today.locator(".cal-draft-input");
  await expect(draft).toBeVisible();
  await draft.fill("Studio hold");
  await draft.press("Enter");

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn’t create “Studio hold”");
});

// The fix landed in the panes but skipped App's own four
// create lanes — the ones the PALETTE drives, where the silence is worst:
// run() closes the palette before the promise settles, so a refused create
// takes the typed title with it. The toast names the title and the engine's
// reason; the note never appears.

test("a refused palette sheet create surfaces on the toast (SUB-656)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_create"]);
  });

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("Album [Remixes]");
  await page.locator(".palette-item", { hasText: "New sheet" }).click();

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn’t create sheet “Album [Remixes]”");
  await expect(toast).toContainText("mock failure: vault_create");
  // the refused sheet never opened
  await expect(page.locator(".note-title")).not.toHaveValue("Album [Remixes]");
});

test("a refused palette typed create surfaces on the toast (SUB-656)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_create"]);
  });

  await page.keyboard.press("Meta+k");
  const input = page.locator(".palette-input");
  await input.fill("template");
  await page.locator(".palette-item", { hasText: "New from template…" }).click();
  await page.locator(".palette-item", { hasText: "New release…" }).click();
  await input.fill("Second [Pressing]");
  await page.locator(".palette-item", { hasText: "New release “Second [Pressing]”" }).click();

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn’t create “Second [Pressing]”");
  await expect(toast).toContainText("mock failure: vault_create");
});

test("a refused URL capture surfaces on the toast (SUB-656)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(() => {
    window.__mockFail = new Set(["url_capture"]);
  });

  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("https://hyperdub.net/releases");
  await page.locator(".palette-item", { hasText: "Capture URL" }).click();

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn’t capture https://hyperdub.net/releases");
  await expect(toast).toContainText("mock failure: url_capture");
});

test("a refused ⌘N scratch note surfaces on the toast (SUB-656)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".list-title")).toBeVisible();
  await page.evaluate(() => {
    window.__mockFail = new Set(["vault_create"]);
  });

  await page.keyboard.press("Meta+n");

  const toast = page.locator(".toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("couldn’t create note");
  await expect(toast).toContainText("mock failure: vault_create");
});
