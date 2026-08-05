import { expect, test } from "@playwright/test";
import { openDb, openFilter } from "./nav";

// Negated query filters against the mock backend, like the other
// database specs: `-key:value` keeps exactly the notes the positive filter
// would drop, and a `-` that prefixes no filter shape stays plain text.

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("database filter: negated select keeps the complement (SUB-198)", async ({ page }) => {
  await openDb(page, "Release");
  // 5 releases: live ×2, in review ×1, mastering ×2
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  await (await openFilter(page)).fill("-status:mastering ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".list-count")).toHaveText("3 of 5");
  await expect(page.locator(".db-table .db-title", { hasText: "Vessel Songs" })).toHaveCount(0);

  // none-of over several values: only the two mastering rows remain
  await page.locator(".db-filter-input").fill('-status:live,"in review" ');
  await expect(page.locator(".db-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".list-count")).toHaveText("2 of 5");
});

test("database filter: negated comparison keeps the complement (SUB-198)", async ({ page }) => {
  await page
    .locator(".side-item", { has: page.locator(".side-db-chip") })
    .filter({ has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .click();
  // every one of the 17 seeded tasks has a due, and `due < 7d` keeps 13 —
  // the negation keeps exactly the other 4 (due +8/+9/+11/+16)
  await expect(page.locator(".db-table tbody tr")).toHaveCount(17);
  await (await openFilter(page)).fill("-due < 7d ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".list-count")).toHaveText("4 of 17");
  await expect(
    page.locator(".db-table tbody tr", { hasText: "Send SMP-029 promos" })
  ).toHaveCount(1);
});

test("database filter: a hyphen that prefixes no filter stays text (SUB-198)", async ({ page }) => {
  await page
    .locator(".side-item", { has: page.locator(".side-db-chip") })
    .filter({ has: page.locator(".side-label-text", { hasText: /^Tasks$/ }) })
    .click();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(17);

  // `-foo` is a title word, not a filter — no task title contains it, and a
  // misparsed negated filter would have kept all 17 rows instead
  await (await openFilter(page)).fill("-foo ");
  await expect(page.locator(".list-count")).toHaveText("0 of 17");
});

test("database filter: completion chips spell and apply a negated filter (SUB-198)", async ({ page }) => {
  await openDb(page, "Release");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(5);

  await (await openFilter(page)).fill("-status:li");
  const chip = page.locator(".search-completion", { hasText: "not status:live" });
  await expect(chip).toHaveCount(1);

  // picking the chip completes the stub with its `-` intact
  await chip.click();
  await expect(page.locator(".db-filter-input")).toHaveValue("-status:live ");
  await expect(page.locator(".db-table tbody tr")).toHaveCount(3);
});
