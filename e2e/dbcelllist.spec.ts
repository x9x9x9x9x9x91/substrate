import { expect, test } from "@playwright/test";
import { openDb } from "./nav";

// The table half of SUB-553 (SUB-557). A cell whose column has no list-shaped
// kind falls back to the raw text editor, and that editor is seeded from
// propStr — which renders a stored YAML list as the joined string "Vinyl,
// Digital". Committing that text wrote it back as ONE scalar, so opening a
// list-valued cell and pressing Enter collapsed the list, on a save that
// reported success. `artist` is a release prop with no schema entry, so it is
// exactly that fallback path; the list is staged through the mock hook the
// way an imported or hand-edited note would carry one.

const NOTE = "Slow Bloom EP.md";

/** the data-column index of a prop, read off the table header (title first) */
async function colIndex(page: import("@playwright/test").Page, col: string) {
  return page
    .locator(".db-table thead th")
    .evaluateAll(
      (ths, c) => ths.findIndex((th) => th.textContent?.trim().toLowerCase().startsWith(c)),
      col
    );
}

test("a list-valued cell in an untyped column survives the raw editor (SUB-557)", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate((p) => window.__mockEditProp!(p, "artist", ["Ase", "Noa"]), NOTE);
  await openDb(page, "Release");

  const artist = await colIndex(page, "artist");
  const row = page.locator("tr", {
    has: page.locator(".db-title-txt", { hasText: "Slow Bloom EP" }),
  });
  const cell = row.locator("td").nth(artist);
  await expect(cell).toHaveText("Ase, Noa");

  // an untouched cell short-circuits on the value === current check, so it
  // was never the bug — assert it anyway so the guard can't quietly go
  await cell.click();
  const input = page.locator(".selmenu .selmenu-input");
  await expect(input).toHaveValue("Ase, Noa");
  await input.press("Enter");
  await expect(page.locator(".selmenu")).toHaveCount(0);
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "artist"), NOTE)).toEqual(["Ase", "Noa"]);
  await expect(cell).toHaveText("Ase, Noa");

  // a genuine edit is where the list used to collapse: this appends instead
  await cell.click();
  await page.locator(".selmenu .selmenu-input").fill("Ase, Noa, Gero");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  await expect(cell).toHaveText("Ase, Noa, Gero");
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "artist"), NOTE)).toEqual([
    "Ase",
    "Noa",
    "Gero",
  ]);

  // editing down to one value stores the scalar form, as the pickers do
  await cell.click();
  await page.locator(".selmenu .selmenu-input").fill("Gero");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "artist"), NOTE)).toEqual("Gero");

  // a scalar cell is untouched — a comma in plain text stays plain text
  const scalar = row.locator("td").nth(await colIndex(page, "cat#"));
  await scalar.click();
  await page.locator(".selmenu .selmenu-input").fill("SMP-030, remaster");
  await page.locator(".selmenu .selmenu-input").press("Enter");
  expect(await page.evaluate((p) => window.__mockPropOf!(p, "cat#"), NOTE)).toEqual(
    "SMP-030, remaster"
  );
});
