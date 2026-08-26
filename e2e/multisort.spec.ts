import { expect, test, type Page } from "./fixtures";
import { openDb } from "./nav";

// Multi-key sorting: plain header click replaces the sort
// (asc → desc → none, as before); shift-click adds or cycles a SECONDARY key
// and the table sorts lexicographically over the key list, with a muted
// ordinal riding each active header's arrow. Runs against the deterministic
// mock backend (fresh page = fresh vault). The catalog db is the lane: 36
// releases whose statuses repeat in blocks of nine, so a status sort leaves
// wide ties for the secondary key to break.

// titles of the seeded "live" block (catalog rows 0–8), in mock insertion
// order — the set, not the order the table shows them in. status is a
// schema'd select, so the key sorts by option order: live is option 0 of
// [live, in review, mastering, parked] and leads asc — under the old
// lexicographic collation "in review" led instead. Rows that TIE on
// the whole key list order by path — the total order the headless view
// reader shares, deterministic where the old stable-sort ties inherited
// whatever order the feed happened to deliver. Catalog paths here are
// `<title>.md`, so on THIS fixture the path tie-break and title order are
// indistinguishable: what the spec pins is that ties rest somewhere
// deterministic, not which of the two rules put them there.
const LIVE_SEEDED = [
  "Night Parcel EP",
  "Copper Season",
  "Meadow Hush",
  "Gullwing",
  "Slow Arrivals",
  "Tinfoil Sky",
  "Amber Rooms",
  "Field Lines",
  "Quiet Machinery",
];
// the same block ordered by the Name column, i.e. by the ONE collation the
// table sorts titles with: `sortCollator` in src/lib/dbsort.ts, built as
// `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`. The
// localeCompare call below is that collator's specified equivalent, so this
// baseline moves with the app's own semantics rather than approximating them
// — a title with digits or diacritics in it would order the same way here as
// it does on screen. Ties the sort leaves unresolved are NOT collated: they
// rest in path order, which for these nine is the same sequence.
const LIVE_ASC = [...LIVE_SEEDED].sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
);
const LIVE_DESC = [...LIVE_ASC].reverse();

async function openCatalog(page: Page) {
  await page.goto("/");
  await openDb(page, "Catalog");
  await expect(page.locator(".db-table")).toBeVisible();
  await expect(page.locator(".db-table tbody tr")).toHaveCount(36);
}

const statusHead = (page: Page) => page.locator(".db-th-label", { hasText: "status" });
const nameHead = (page: Page) => page.locator(".db-th-title");
/** titles of the first nine data rows — exactly one status block's worth */
const firstNine = (page: Page) => page.locator(".db-table tbody tr .db-title").evaluateAll(
  (els) => els.slice(0, 9).map((el) => el.textContent ?? "")
);

test("shift-click adds a secondary key: the sort cascades, ordinals mark the key order", async ({
  page,
}) => {
  await openCatalog(page);

  // primary: status asc — the "live" block leads (schema option order), its
  // ties resting in path order (= title order on this fixture)
  await statusHead(page).click();
  await expect(statusHead(page).locator(".db-sort")).toHaveText("↑");
  await expect(page.locator(".db-sort-ord")).toHaveCount(0);
  expect(await firstNine(page)).toEqual(LIVE_ASC);

  // shift-click Name: the block stays put and its rows hold title order.
  // Asc is NOT evidence of anything on this fixture — the mock's catalog
  // paths are `<title>.md`, so the path tie-break and a title sort produce
  // the same nine rows, and no assertion here can tell them apart. The
  // discriminating case (paths that collate the opposite way to their
  // titles) is pinned in src/lib/vieweval.test.ts. What this step proves is
  // the ordinals; the desc flip below is the behavioral one.
  await nameHead(page).click({ modifiers: ["Shift"] });
  await expect(statusHead(page).locator(".db-sort-ord")).toHaveText("1");
  await expect(nameHead(page).locator(".db-sort-ord")).toHaveText("2");
  expect(await firstNine(page)).toEqual(LIVE_ASC);

  // shift-click Name again: only the secondary's direction flips
  await nameHead(page).click({ modifiers: ["Shift"] });
  await expect(nameHead(page).locator(".db-sort")).toContainText("↓");
  expect(await firstNine(page)).toEqual(LIVE_DESC);

  // a third shift-click drops the secondary — the primary's resting tie
  // order (path, = title on this fixture) returns
  await nameHead(page).click({ modifiers: ["Shift"] });
  await expect(page.locator(".db-sort-ord")).toHaveCount(0);
  await expect(statusHead(page).locator(".db-sort")).toHaveText("↑");
  expect(await firstNine(page)).toEqual(LIVE_ASC);
});

test("a plain click on another column resets to a single sort", async ({ page }) => {
  await openCatalog(page);
  await statusHead(page).click();
  await nameHead(page).click({ modifiers: ["Shift"] });
  await expect(page.locator(".db-sort-ord")).toHaveCount(2);

  await page.locator(".db-th-label", { hasText: "artist" }).click();
  await expect(page.locator(".db-sort-ord")).toHaveCount(0);
  await expect(page.locator(".db-sort")).toHaveCount(1);
  await expect(
    page.locator(".db-th-label", { hasText: "artist" }).locator(".db-sort")
  ).toHaveText("↑");
  await expect(statusHead(page).locator(".db-sort")).toHaveCount(0);
});

test("a saved view persists the full key list and restores it on open", async ({ page }) => {
  await openCatalog(page);
  await statusHead(page).click();
  await nameHead(page).click({ modifiers: ["Shift"] });
  await expect(page.locator(".db-sort-ord")).toHaveCount(2);

  // pin the multi-sorted table
  await page.locator("button[aria-label='View actions']").click();
  await page.locator(".dots-item", { hasText: "Save view…" }).click();
  const nameInput = page.locator(".db-filter .inline-edit");
  await nameInput.fill("Multi");
  await nameInput.press("Enter");
  await expect(page.locator(".side-view", { hasText: "Multi" })).toHaveCount(1);

  // reset to a plain artist sort, then open the pin — both keys come back
  await page.locator(".db-th-label", { hasText: "artist" }).click();
  await expect(page.locator(".db-sort-ord")).toHaveCount(0);
  await page.locator(".side-view", { hasText: "Multi" }).click();
  await expect(page.locator(".list-title")).toHaveText("Catalog");
  await expect(page.locator(".db-tab.active")).toHaveText("Multi⌘5");
  await expect(statusHead(page).locator(".db-sort-ord")).toHaveText("1");
  await expect(nameHead(page).locator(".db-sort-ord")).toHaveText("2");
  expect(await firstNine(page)).toEqual(LIVE_ASC);
});
