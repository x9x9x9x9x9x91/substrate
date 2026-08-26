import { expect, test } from "./fixtures";

// A list-valued prop on an UNTYPED note. Untyped notes have no
// schema, so their chips edit as plain text — and the text a list chip shows
// is propStr's comma-joined render. Committing that text used to write it
// back as ONE scalar string, so merely clicking the chip and clicking away
// collapsed the note's YAML list, on a write that reported success.

const NOTE = "Split the stem pack";

test("editing a list chip on an untyped note keeps it a list (SUB-553)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Ideas" }).first().click();
  await page.locator(".row", { hasText: NOTE }).first().click();
  await expect(page.locator(".note-title")).toHaveValue(NOTE);

  const chip = page.locator(".chip", { hasText: "format" });
  await expect(chip).toContainText("Vinyl, Digital");

  // open the plain editor and click away without typing anything
  await chip.click();
  const input = page.locator(".chip-input");
  await expect(input).toBeVisible();
  await input.press("Enter");
  await expect(page.locator(".chip-input")).toHaveCount(0);

  // the stored value is still a two-entry list, not the joined string
  const stored = await page.evaluate(
    (p) => window.__mockPropOf!(p, "format"),
    `Ideas/${NOTE}.md`
  );
  expect(stored).toEqual(["Vinyl", "Digital"]);
  await expect(chip).toContainText("Vinyl, Digital");

  // adding a value through the same plain editor appends to the list
  await chip.click();
  await page.locator(".chip-input").fill("Vinyl, Digital, Tape");
  await page.locator(".chip-input").press("Enter");
  await expect(chip).toContainText("Vinyl, Digital, Tape");
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "format"), `Ideas/${NOTE}.md`)
  ).toEqual(["Vinyl", "Digital", "Tape"]);

  // editing down to one value stores the scalar form, as the pickers do
  await chip.click();
  await page.locator(".chip-input").fill("Tape");
  await page.locator(".chip-input").press("Enter");
  expect(
    await page.evaluate((p) => window.__mockPropOf!(p, "format"), `Ideas/${NOTE}.md`)
  ).toEqual("Tape");
});
