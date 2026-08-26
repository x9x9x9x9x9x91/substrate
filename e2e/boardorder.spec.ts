import { expect, test, type Page } from "./fixtures";
import { openDb, openFilter } from "./nav";

// a board drag lands where the pointer says. On an UNSORTED board a
// 2px accent line shows the exact slot and the card stays there — the order
// lives on the view's prefs (views.json in the real engine, mockViews here),
// never as a prop in a note. On a SORTED board there is no line, because the
// sort owns the order: the card snaps to its sorted slot instead, with the
// landing flash so the jump is legible. Deterministic mock backend
// (fresh page = fresh vault).

async function openBoard(page: Page) {
  await openDb(page, "Release");
  await page.locator('.db-switch button[title="Board"]').click();
  await expect(page.locator(".db-board")).toBeVisible();
}

/** the first board column holding at least two cards, with its titles */
async function firstFullCol(page: Page): Promise<{ index: number; titles: string[] }> {
  const cols = page.locator(".db-board .db-col");
  for (let i = 0; i < (await cols.count()); i++) {
    const titles = await cols.nth(i).locator(".db-card-title").allTextContents();
    if (titles.length >= 2) return { index: i, titles };
  }
  throw new Error("no board column with two cards");
}

const colTitles = (page: Page, i: number) =>
  page.locator(".db-board .db-col").nth(i).locator(".db-card-title").allTextContents();

// Chromium's synthetic-mouse drag never reaches the app's dragstart with a
// usable payload (see colorder.spec.ts), so dispatch with a real DataTransfer
// and let the app's own handlers do the work. A dispatched event carries no
// clientY, i.e. y=0 — above the target card's midpoint, so the drop lands the
// dragged card BEFORE it.
async function dragCardBefore(page: Page, colIndex: number, from: number, to: number) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const cards = page.locator(".db-board .db-col").nth(colIndex).locator(".db-card");
  await cards.nth(from).dispatchEvent("dragstart", { dataTransfer });
  const target = cards.nth(to);
  await target.dispatchEvent("dragover", { dataTransfer });
  return { dataTransfer, target };
}

/** the same, with a real clientY just past the target card's midpoint — the
    only way to exercise the AFTER half of the slot decision, since a
    dispatched event's default y=0 always reads as "before" */
async function dragCardAfter(page: Page, colIndex: number, from: number, to: number) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const cards = page.locator(".db-board .db-col").nth(colIndex).locator(".db-card");
  await cards.nth(from).dispatchEvent("dragstart", { dataTransfer });
  const target = cards.nth(to);
  const box = (await target.boundingBox())!;
  await target.dispatchEvent("dragover", { dataTransfer, clientY: box.y + box.height - 2 });
  return { dataTransfer, target };
}

test("unsorted board: the insertion line shows the slot and the card stays in it", async ({
  page,
}) => {
  await page.goto("/");
  await openBoard(page);

  const { index, titles } = await firstFullCol(page);
  const moved = titles[1];
  const { dataTransfer, target } = await dragCardBefore(page, index, 1, 0);

  // the line names the slot BEFORE the first card — and only that one card
  // wears it, so it can't read as a whole-column promise
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(1);
  await expect(page.locator(".db-card.db-drop-before .db-card-title")).toHaveText(titles[0]);
  await expect(page.locator(".db-card.db-drop-after")).toHaveCount(0);

  await target.dispatchEvent("drop", { dataTransfer });
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(0);
  expect(await colTitles(page, index)).toEqual([moved, ...titles.filter((t) => t !== moved)]);

  // the hand order rides the ViewPref, so it survives leaving the database
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await openBoard(page);
  expect(await colTitles(page, index)).toEqual([moved, ...titles.filter((t) => t !== moved)]);
});

test("unsorted board: dropping past a card's midpoint lands AFTER it", async ({ page }) => {
  await page.goto("/");
  await openBoard(page);

  const { index, titles } = await firstFullCol(page);
  const { dataTransfer, target } = await dragCardAfter(page, index, 0, 1);

  // the line sits under the second card, not above it
  await expect(page.locator(".db-card.db-drop-after")).toHaveCount(1);
  await expect(page.locator(".db-card.db-drop-after .db-card-title")).toHaveText(titles[1]);
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(0);

  await target.dispatchEvent("drop", { dataTransfer, clientY: 0 });
  expect(await colTitles(page, index)).toEqual([titles[1], titles[0], ...titles.slice(2)]);
});

test("unsorted board: the empty tail under the last card means 'put it last'", async ({ page }) => {
  await page.goto("/");
  await openBoard(page);

  const { index, titles } = await firstFullCol(page);
  const col = page.locator(".db-board .db-col").nth(index);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await col.locator(".db-card").first().dispatchEvent("dragstart", { dataTransfer });
  // the gap below the cards is still the column, so it names the last slot
  await col.locator(".db-col-body").dispatchEvent("dragover", { dataTransfer });
  await expect(page.locator(".db-card.db-drop-after .db-card-title")).toHaveText(
    titles[titles.length - 1],
  );

  await col.locator(".db-col-body").dispatchEvent("drop", { dataTransfer });
  expect(await colTitles(page, index)).toEqual([...titles.slice(1), titles[0]]);
});

test("unsorted board: no line over the card being dragged", async ({ page }) => {
  await page.goto("/");
  await openBoard(page);

  const { index } = await firstFullCol(page);
  const cards = page.locator(".db-board .db-col").nth(index).locator(".db-card");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await cards.nth(1).dispatchEvent("dragstart", { dataTransfer });
  await cards.nth(0).dispatchEvent("dragover", { dataTransfer });
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(1);

  // coming back over itself: the slot from the card before must not linger
  await cards.nth(1).dispatchEvent("dragover", { dataTransfer });
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(0);
  await expect(page.locator(".db-card.db-drop-after")).toHaveCount(0);
});

test("unsorted board: a drag under a filter leaves the hidden cards alone", async ({ page }) => {
  await page.goto("/");
  await openBoard(page);

  // arrange one column by hand, then filter it out of sight entirely
  const first = await firstFullCol(page);
  const arranged = [first.titles[1], first.titles[0], ...first.titles.slice(2)];
  const one = await dragCardBefore(page, first.index, 1, 0);
  await one.target.dispatchEvent("drop", { dataTransfer: one.dataTransfer });
  expect(await colTitles(page, first.index)).toEqual(arranged);

  await (await openFilter(page)).fill("status:mastering ");
  await expect(page.locator(".db-board .db-col").nth(first.index).locator(".db-card")).toHaveCount(
    0,
  );

  // a move made while they are hidden rewrites the saved arrangement — it has
  // to splice into it, not regenerate it from what the board is showing
  const other = await firstFullCol(page);
  const two = await dragCardBefore(page, other.index, 1, 0);
  await two.target.dispatchEvent("drop", { dataTransfer: two.dataTransfer });
  expect(await colTitles(page, other.index)).toEqual([
    other.titles[1],
    other.titles[0],
    ...other.titles.slice(2),
  ]);

  await page.locator(".db-filter-input").fill("");
  expect(await colTitles(page, first.index)).toEqual(arranged);
});

test("unsorted board: a cross-column drop still writes the group", async ({ page }) => {
  await page.goto("/");
  await openBoard(page);

  const { index, titles } = await firstFullCol(page);
  const cols = page.locator(".db-board .db-col");
  const otherIndex = index === 0 ? 1 : 0;
  const moved = titles[0];

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await cols.nth(index).locator(".db-card").first().dispatchEvent("dragstart", { dataTransfer });
  // no insertion line: the card is not a member of this column, so the drop
  // means "change the group", which the hand order has no say over
  await cols.nth(otherIndex).dispatchEvent("dragover", { dataTransfer });
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(0);
  await expect(page.locator(".db-card.db-drop-after")).toHaveCount(0);

  await cols.nth(otherIndex).dispatchEvent("drop", { dataTransfer });
  await expect(cols.nth(otherIndex).locator(".db-card-title", { hasText: moved })).toHaveCount(1);
  await expect(cols.nth(otherIndex).locator(".db-card.db-flashing")).toHaveCount(1);
  expect(await colTitles(page, index)).toEqual(titles.slice(1));
});

test("unsorted board: the move is undoable from the toast and from ⌘Z", async ({ page }) => {
  await page.goto("/");
  await openBoard(page);

  const { index, titles } = await firstFullCol(page);
  const { dataTransfer, target } = await dragCardBefore(page, index, 1, 0);
  await target.dispatchEvent("drop", { dataTransfer });
  expect((await colTitles(page, index))[0]).toBe(titles[1]);

  await page.locator(".toast button", { hasText: "Undo" }).click();
  expect(await colTitles(page, index)).toEqual(titles);

  // the keyboard pops the same entry the toast button does, so a
  // second undo must not fire again on an already-undone move
  const again = await dragCardBefore(page, index, 1, 0);
  await again.target.dispatchEvent("drop", { dataTransfer: again.dataTransfer });
  expect((await colTitles(page, index))[0]).toBe(titles[1]);
  await page.keyboard.press("Meta+z");
  expect(await colTitles(page, index)).toEqual(titles);
});

test("sorted board: no insertion line — the card snaps to its sorted slot", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  // a sort set in the table rides the same ViewPref into the board
  await page.locator(".db-th-title").click();
  await page.locator('.db-switch button[title="Board"]').click();
  await expect(page.locator(".db-board")).toBeVisible();

  const { index, titles } = await firstFullCol(page);
  const cards = page.locator(".db-board .db-col").nth(index).locator(".db-card");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await cards.nth(1).dispatchEvent("dragstart", { dataTransfer });
  await cards.nth(0).dispatchEvent("dragover", { dataTransfer });

  // the line would lie here: the sort, not the pointer, decides the slot
  await expect(page.locator(".db-card.db-drop-before")).toHaveCount(0);
  await expect(page.locator(".db-card.db-drop-after")).toHaveCount(0);
  // the column still says WHICH column the drop lands in
  await expect(page.locator(".db-board .db-col").nth(index)).toHaveClass(/drop/);

  await cards.nth(0).dispatchEvent("drop", { dataTransfer });
  // a within-column drop on a sorted board writes nothing and moves nothing
  expect(await colTitles(page, index)).toEqual(titles);
});

test("sorted board: a cross-column drop still writes the group and flashes", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Release");
  await page.locator(".db-th-title").click();
  await page.locator('.db-switch button[title="Board"]').click();
  await expect(page.locator(".db-board")).toBeVisible();

  const { index, titles } = await firstFullCol(page);
  const cols = page.locator(".db-board .db-col");
  const otherIndex = index === 0 ? 1 : 0;
  const moved = titles[0];

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await cols.nth(index).locator(".db-card").first().dispatchEvent("dragstart", { dataTransfer });
  await cols.nth(otherIndex).dispatchEvent("dragover", { dataTransfer });
  await cols.nth(otherIndex).dispatchEvent("drop", { dataTransfer });

  await expect(cols.nth(otherIndex).locator(".db-card-title", { hasText: moved })).toHaveCount(1);
  // the card that just moved lights once so the jump is followable
  await expect(cols.nth(otherIndex).locator(".db-card.db-flashing")).toHaveCount(1);
});
