import { expect, test, type Page } from "@playwright/test";

// Board undo is per-note identity: leaving a board withdraws its history, so a
// chord on the next board can never write the previous one's sheet. Vehicled on
// the food board — it writes to a separate log note, so "did the undo land"
// is a body comparison rather than a rendering guess.

async function refreshMockVault(page: Page) {
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
}

/** A second food board with its own log, differing from the original by one
    row so a stray write to the wrong sheet is visible. */
async function stageCaloriesTwin(page: Page) {
  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Calories.md", "Dashboards/Calories Twin.md");
    window.__mockCloneNote?.("Food Log.md", "Food Log Twin.md");
    window.__mockEditProp?.("Dashboards/Calories Twin.md", "log", "Food Log Twin");
    const body = window.__mockBodyOf?.("Food Log Twin.md") ?? "";
    window.__mockEditNote?.(
      "Food Log Twin.md",
      body.replace("Chicken bowl,650,45", "Twin Chicken bowl,650,45")
    );
  });
}

async function addMeal(page: Page, name: string, kcal: string) {
  const form = page.locator(".dash-form:not(.food-db-form)");
  await form.locator("input[type=text]").fill(name);
  await form.locator("label", { hasText: "kcal" }).locator("input").fill(kcal);
  await form.locator(".dash-add").click();
  await expect(page.locator(".food-row", { hasText: name })).toBeVisible();
}

test("same-kind Food navigation cannot write the previous board's log (SUB-726 review)", async ({
  page,
}) => {
  await page.goto("/");
  await stageCaloriesTwin(page);
  await refreshMockVault(page);

  await page.locator(".side-item", { hasText: "Calories" }).first().click();
  await addMeal(page, "Review meal", "100");

  await page.locator(".side-item", { hasText: "Calories Twin" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Calories Twin");
  const before = await page.evaluate(() => window.__mockBodyOf?.("Food Log Twin.md"));
  expect(before).toContain("Twin Chicken bowl");

  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => window.__mockBodyOf?.("Food Log Twin.md"))).toBe(before);
});

test("workbook note-to-note board navigation withdraws outgoing history (SUB-726 review)", async ({
  page,
}) => {
  await page.goto("/");
  await stageCaloriesTwin(page);
  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Portfolio.md", "Dashboards/Food Workbook.md");
    window.__mockEditProp?.("Dashboards/Food Workbook.md", "pages", [
      { label: "Food A", note: "Calories" },
      { label: "Food B", note: "Calories Twin" },
    ]);
  });
  await refreshMockVault(page);

  await page.locator(".side-item", { hasText: "Food Workbook" }).click();
  await page.locator(".wb-tab", { hasText: "Food A" }).click();
  await addMeal(page, "Workbook meal", "100");

  await page.locator(".wb-tab", { hasText: "Food B" }).click();
  const before = await page.evaluate(() => window.__mockBodyOf?.("Food Log Twin.md"));
  expect(before).toContain("Twin Chicken bowl");

  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => window.__mockBodyOf?.("Food Log Twin.md"))).toBe(before);
});

test("back-to-back board undo chords chain through live state (SUB-726 review)", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Calories" }).first().click();
  await addMeal(page, "Chord one", "100");
  await addMeal(page, "Chord two", "110");

  const probe = await page.evaluate(() => {
    const chord = (shiftKey = false) => {
      const event = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      const dispatched = document.body.dispatchEvent(event);
      return {
        dispatched,
        prevented: event.defaultPrevented,
        metaKey: event.metaKey,
        key: event.key,
      };
    };
    return [chord(), chord()];
  });
  expect(probe).toEqual([
    { dispatched: false, prevented: true, metaKey: true, key: "z" },
    { dispatched: false, prevented: true, metaKey: true, key: "z" },
  ]);
  // both adds withdrawn, the seeded log untouched underneath them
  await expect
    .poll(() => page.evaluate(() => window.__mockBodyOf?.("Food Log.md")))
    .not.toContain("Chord one");
  await expect(page.locator(".food-row", { hasText: "Chord two" })).toHaveCount(0);
});
