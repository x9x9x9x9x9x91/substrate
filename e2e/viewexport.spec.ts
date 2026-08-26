import { expect, test } from "./fixtures";
import { openDb, openFilter } from "./nav";

// A saved view can be exported as a folder of links other apps can
// see. The export is explicit — the pin's menu offers it, the first one asks
// where, and every later Regenerate silently reuses that folder. Runs against
// the mock backend; the native folder dialog and the real symlinks are
// covered by the Rust unit tests instead.

/** Save the current filter as a pin named `name`. */
async function savePin(page: import("@playwright/test").Page, query: string, name: string) {
  const input = page.locator(".db-filter-input");
  if (await input.count()) await input.fill(query);
  else await (await openFilter(page)).fill(query);
  await page.locator(".db-filter-save").click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill(name);
  await nameInput.press("Enter");
}

test("a pin's menu exports as a link folder, then regenerates into the same one", async ({
  page,
}) => {
  await page.goto("/");
  await openDb(page, "Release");
  await savePin(page, "status:live ", "Live releases");

  const tab = page.locator(".db-tab", { hasText: "Live releases" });
  await tab.click({ button: "right" });
  // never exported: the menu asks where, and says so with the ellipsis
  await expect(page.locator(".ctx-item", { hasText: "Export as link folder…" })).toHaveCount(1);
  await expect(page.locator(".ctx-item", { hasText: "Regenerate link folder" })).toHaveCount(0);

  // outside the desktop app there is no folder dialog, so the first export
  // says so instead of half-doing something
  await page.locator(".ctx-item", { hasText: "Export as link folder…" }).click();
  await expect(page.locator(".toast")).toContainText("desktop app");

  // stage the state a real first export would leave behind, then make the
  // app re-read its per-machine targets (saving another pin does that)
  await page.evaluate(() =>
    window.__mockSetExportTarget?.("Live releases", "/Users/x/Music/Live Sets/Live releases")
  );
  await savePin(page, "status:mastering ", "Mastering");

  // now the same pin offers Regenerate — no question, and the folder it
  // reuses is named in the menu
  await page.locator(".db-tab", { hasText: "Live releases" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Export as link folder…" })).toHaveCount(0);
  const regen = page.locator(".ctx-item", { hasText: "Regenerate link folder" });
  await expect(regen).toContainText("Live releases");
  await expect(page.locator(".ctx-item", { hasText: "Export to a new location…" })).toHaveCount(1);

  // regenerating reports what landed: the view matches 2 of the 5 releases
  await regen.click();
  await expect(page.locator(".toast")).toContainText("2 links in Live releases");

  // the pin that was never exported still asks where
  await page.locator(".db-tab", { hasText: "Mastering" }).click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Export as link folder…" })).toHaveCount(1);
});
