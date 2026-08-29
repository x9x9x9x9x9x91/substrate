import { expect, seedSortable, test, type Page } from "./fixtures";

/* Scratch, Notes and a folder pane are one surface wearing three names, and
   the order they show is the vault's answer rather than this window's. So the
   round trip is what these specs walk: pick in the header, read the key back
   out of Settings.md, and — the other direction — hand-edit the note and
   watch the rows move with no visit to the control. */

const FOLDER = "Inbox";
/* the seeded five, by stem — the folder is one the mock vault already keeps
   notes in, and this spec is about the order of the notes it can predict */
const SEEDED = ["Zebra", "Mallow", "Alder", "Tie Beta", "Tie Alpha"];

/** The seeded rows in the order the list is painting them, top to bottom. */
async function order(page: Page): Promise<string[]> {
  return page
    .locator(`.list .row[data-path^="${FOLDER}/"]`)
    .evaluateAll((els, seeded) =>
      els
        .map((el) => el.getAttribute("data-path")!.replace(/^[^/]+\//, "").replace(/\.md$/, ""))
        .filter((stem) => seeded.includes(stem)),
      SEEDED
    );
}

async function openSeeded(page: Page) {
  await seedSortable(page, FOLDER);
  await page.goto("/");
  await page.locator(".side-folder", { hasText: FOLDER }).click();
  await expect(page.locator(".list-title")).toHaveText(FOLDER);
  await expect(page.locator(".list-sort-btn")).toBeVisible();
}

/** Pick a field in the header's sort menu. Picking the field the list is
    already on is the direction flip. */
async function pick(page: Page, field: "updated" | "created" | "name") {
  await page.locator(".list-sort-btn").click();
  await page.locator(`.list-sort-menu [data-sort-field="${field}"]`).click();
  await expect(page.locator(".list-sort-menu")).toHaveCount(0);
}

const storedSort = (page: Page) =>
  page.evaluate(() => window.__mockPropOf!("Settings.md", "note-sort"));

test("a folder opens on last edited, newest first, and settles its ties by path", async ({
  page,
}) => {
  await openSeeded(page);
  // Zebra was edited a second ago, Alder a minute; the two Tie notes share a
  // millisecond, so only the path key can separate them — and it must put
  // them in the same place on every render of the same unchanged notes
  expect(await order(page)).toEqual(["Zebra", "Mallow", "Alder", "Tie Alpha", "Tie Beta"]);

  // a vault that never chose has written nothing: the default is the app's,
  // not a value sitting in the note
  expect(await storedSort(page)).toBeFalsy();
});

test("the header control reorders the list and writes the choice to Settings.md", async ({
  page,
}) => {
  await openSeeded(page);

  await pick(page, "name");
  expect(await order(page)).toEqual(["Alder", "Mallow", "Tie Alpha", "Tie Beta", "Zebra"]);
  await expect.poll(() => storedSort(page)).toBe("name asc");

  // the field the list is already on flips its direction
  await pick(page, "name");
  expect(await order(page)).toEqual(["Zebra", "Tie Beta", "Tie Alpha", "Mallow", "Alder"]);
  await expect.poll(() => storedSort(page)).toBe("name desc");

  // created is the note's own date, and the two notes that have none sort
  // last — a missing date is not an ancient one
  await pick(page, "created");
  expect(await order(page)).toEqual(["Zebra", "Mallow", "Alder", "Tie Alpha", "Tie Beta"]);
  await expect.poll(() => storedSort(page)).toBe("created desc");
  await pick(page, "created");
  expect(await order(page)).toEqual(["Alder", "Mallow", "Zebra", "Tie Alpha", "Tie Beta"]);
  await expect.poll(() => storedSort(page)).toBe("created asc");
});

test("⌘Z puts the list back on the order it was on", async ({ page }) => {
  await openSeeded(page);
  const first = await order(page);

  await pick(page, "name");
  expect(await order(page)).not.toEqual(first);
  await expect.poll(() => storedSort(page)).toBe("name asc");

  // a sort flip is an edit to the vault like any other row of the ⌘, sheet
  await page.keyboard.press("Meta+z");
  await expect.poll(() => order(page)).toEqual(first);
});

test("the choice follows the vault — Scratch reads the same key the folder wrote", async ({
  page,
}) => {
  await openSeeded(page);
  await pick(page, "name");
  await expect.poll(() => storedSort(page)).toBe("name asc");

  await page.locator(".side-item", { hasText: /^Scratch/ }).click();
  await expect(page.locator(".list-sort-btn")).toHaveAttribute("data-sort", "name asc");
});

test("someone editing the setting outside the app reorders the list", async ({ page }) => {
  await openSeeded(page);

  // a hand edit in an editor, or an agent working the vault
  await page.evaluate(() => {
    window.__mockEditProp!("Settings.md", "note-sort", "name asc");
    window.__mockEmit!("vault:changed");
  });
  await expect
    .poll(() => order(page))
    .toEqual(["Alder", "Mallow", "Tie Alpha", "Tie Beta", "Zebra"]);
  await expect(page.locator(".list-sort-btn")).toHaveAttribute("data-sort", "name asc");
});
