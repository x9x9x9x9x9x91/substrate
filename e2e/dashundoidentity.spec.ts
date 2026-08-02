import { expect, test, type Page } from "@playwright/test";

const newestYield = (page: Page) => page.locator(".dash-table tbody tr").first();

async function stageYieldTwin(page: Page) {
  await page.evaluate(() => {
    const source = "Dashboards/Yield APR.md";
    const twin = "Dashboards/Yield APR Twin.md";
    window.__mockCloneNote?.(source, twin);
    const body = window.__mockBodyOf?.(twin) ?? "";
    window.__mockEditNote?.(
      twin,
      body.replace("2026-07-17 14:18,232,15700", "2026-07-17 14:18,7,15700")
    );
  });
}

async function refreshMockVault(page: Page) {
  await page.evaluate(() => window.__mockEmit?.("vault:changed"));
}

async function addYield(page: Page, value: string) {
  await page.locator(".dash-form input").nth(1).fill(value);
  await page.locator(".dash-add").click();
  await expect(newestYield(page)).toContainText(`${value},00 $`);
}

test("same-kind Yield navigation starts with empty board history (SUB-726 review)", async ({
  page,
}) => {
  await page.goto("/");
  await stageYieldTwin(page);
  await refreshMockVault(page);

  await page.locator(".side-item", { hasText: "Yield APR" }).first().click();
  await addYield(page, "250");

  await page.locator(".side-item", { hasText: "Yield APR Twin" }).click();
  await expect(newestYield(page)).toContainText("7,00 $");
  const before = await page.evaluate(() => window.__mockBodyOf?.("Dashboards/Yield APR Twin.md"));

  await page.keyboard.press("Meta+z");
  await expect.poll(() =>
    page.evaluate(() => window.__mockBodyOf?.("Dashboards/Yield APR Twin.md"))
  ).toBe(before);
  await expect(newestYield(page)).toContainText("7,00 $");
});

test("same-kind Food navigation cannot write the previous board's log (SUB-726 review)", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Calories.md", "Dashboards/Calories Twin.md");
    window.__mockCloneNote?.("Food Log.md", "Food Log Twin.md");
    window.__mockEditProp?.("Dashboards/Calories Twin.md", "log", "Food Log Twin");
    const body = window.__mockBodyOf?.("Food Log Twin.md") ?? "";
    window.__mockEditNote?.("Food Log Twin.md", body.replace("Chicken bowl,650,45", "Twin Chicken bowl,650,45"));
  });
  await refreshMockVault(page);

  await page.locator(".side-item", { hasText: "Calories" }).first().click();
  const form = page.locator(".dash-form:not(.food-db-form)");
  await form.locator("input[type=text]").fill("Review meal");
  await form.locator("label", { hasText: "kcal" }).locator("input").fill("100");
  await form.locator(".dash-add").click();
  await expect(page.locator(".food-row", { hasText: "Review meal" })).toBeVisible();

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
  await stageYieldTwin(page);
  await page.evaluate(() => {
    window.__mockCloneNote?.("Dashboards/Portfolio.md", "Dashboards/Yield Workbook.md");
    window.__mockEditProp?.("Dashboards/Yield Workbook.md", "pages", [
      { label: "Yield A", note: "Yield APR" },
      { label: "Yield B", note: "Yield APR Twin" },
    ]);
  });
  await refreshMockVault(page);

  await page.locator(".side-item", { hasText: "Yield Workbook" }).click();
  await page.locator(".wb-tab", { hasText: "Yield A" }).click();
  await addYield(page, "250");

  await page.locator(".wb-tab", { hasText: "Yield B" }).click();
  await expect(newestYield(page)).toContainText("7,00 $");
  const before = await page.evaluate(() => window.__mockBodyOf?.("Dashboards/Yield APR Twin.md"));
  await page.keyboard.press("Meta+z");
  await expect.poll(() =>
    page.evaluate(() => window.__mockBodyOf?.("Dashboards/Yield APR Twin.md"))
  ).toBe(before);
});

test("back-to-back board undo chords chain through live state (SUB-726 review)", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Yield APR" }).click();
  await addYield(page, "250");
  await addYield(page, "260");

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
  await expect.poll(() =>
    page.evaluate(() => window.__mockBodyOf?.("Dashboards/Yield APR.md"))
  ).toContain("2026-07-17 14:18,232,15700");
});
