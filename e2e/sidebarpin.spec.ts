import { expect, test } from "@playwright/test";

// SUB-410: a plain note (no database, no `type: dashboard`) can hold a sidebar
// row. SUB-585: that row lives UNDER the note's home folder in the Folders
// tree; only pins with no tree row (vault root, Journal/Dashboards) keep the
// flat Pinned section. Rows reorder within their lane, and dropping a note on
// its own folder row pins it too.

const NOTE = "Capture anything"; // lives in Inbox — pins nested under the Inbox row
const ROOT_NOTE = "Welcome"; // lives at the vault root — pins into the flat section
const pinnedSection = "Pinned";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  await expect(page.locator(".row", { hasText: NOTE }).first()).toBeVisible();
});

test("pin a folder note: row nests under the folder, opens the note, unpins", async ({ page }) => {
  // Inbox holds no subfolders and no pins yet — no chevron on its row
  const inboxRow = page.locator(".side-folder", { hasText: "Inbox" });
  await expect(inboxRow.locator(".side-chevron")).toHaveCount(0);

  await page.locator(".row", { hasText: NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();

  // the pin renders in the tree under Inbox, not in a flat Pinned section
  await expect(page.locator(".side-section-toggle", { hasText: pinnedSection })).toHaveCount(0);
  const row = page.locator(".side-item", { hasText: NOTE });
  await expect(row).toBeVisible();
  // …and the folder row grew a chevron that folds the pin away
  await expect(inboxRow.locator(".side-chevron")).toHaveCount(1);
  await inboxRow.locator(".side-chevron").click();
  await expect(row).toBeHidden();
  await inboxRow.locator(".side-chevron").click();
  await expect(row).toBeVisible();

  // the pinned row opens the note itself (not a folder or database view)
  await page.locator(".side-folder", { hasText: "Ideas" }).click();
  await row.click();
  await expect(page.locator(".note-title")).toHaveValue(NOTE);

  // the row's own menu flips to Remove pin; unpinning drops the row (and the
  // chevron with it) and leaves the note where it was
  await row.click({ button: "right" });
  await expect(page.locator(".ctx-item", { hasText: "Pin to sidebar" })).toHaveCount(0);
  await page.locator(".ctx-item", { hasText: "Remove pin" }).click();
  await expect(page.locator(".side-item", { hasText: NOTE })).toHaveCount(0);
  await expect(inboxRow.locator(".side-chevron")).toHaveCount(0);

  await page.locator(".side-folder", { hasText: "Inbox" }).click();
  await expect(page.locator(".row", { hasText: NOTE }).first()).toBeVisible();
});

test("a root note pins into the flat Pinned section", async ({ page }) => {
  await expect(page.locator(".side-section-toggle", { hasText: pinnedSection })).toHaveCount(0);
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row", { hasText: ROOT_NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();

  await expect(page.locator(".side-section-toggle", { hasText: pinnedSection })).toBeVisible();
  const row = page.locator(".side-item", { hasText: ROOT_NOTE });
  await expect(row).toBeVisible();

  await row.click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Remove pin" }).click();
  await expect(page.locator(".side-section-toggle", { hasText: pinnedSection })).toHaveCount(0);
});

test("a pin follows the note through a rename", async ({ page }) => {
  await page.locator(".row", { hasText: NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
  await expect(page.locator(".side-item", { hasText: NOTE })).toBeVisible();

  await page.locator(".row", { hasText: NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Rename…" }).click();
  await page.locator(".row input.inline-edit").fill("Pinned scratch");
  await page.keyboard.press("Enter");

  // the engine retargets the stored path — the row keeps its place with the
  // new title rather than vanishing
  await expect(page.locator(".side-item", { hasText: "Pinned scratch" })).toBeVisible();
  await expect(page.locator(".side-item", { hasText: NOTE })).toHaveCount(0);
});

test("trashing a pinned note drops its row", async ({ page }) => {
  await page.locator(".row", { hasText: NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
  await expect(page.locator(".side-item", { hasText: NOTE })).toBeVisible();

  await page.locator(".row", { hasText: NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move to Trash" }).click();

  // the engine drops the pin with the file — no dead row left behind
  await expect(page.locator(".side-item", { hasText: NOTE })).toHaveCount(0);
});

test("dragging a note onto the Pinned section adds a pin", async ({ page }) => {
  // seed one ROOT pin so the flat section (the drop target) exists
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await page.locator(".row", { hasText: ROOT_NOTE }).first().click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
  await expect(page.locator(".side-item", { hasText: ROOT_NOTE })).toBeVisible();

  // synthetic-mouse drags slip the source row in Chromium (see
  // folderorder.spec.ts) — dispatch with a real DataTransfer instead. The
  // row is picked by data-path: hasText also matches EXCERPTS, and two other
  // fixtures mention "Holdings" in theirs.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const other = page.locator('.row[data-path="Holdings.md"]');
  await expect(other).toBeVisible();
  await other.dispatchEvent("dragstart", { dataTransfer });
  const header = page.locator(".side-label-row", { hasText: pinnedSection });
  await header.dispatchEvent("dragover", { dataTransfer });
  await header.dispatchEvent("drop", { dataTransfer });

  await expect(page.locator(".side-item", { hasText: "Holdings" })).toBeVisible();
});

test("dropping a note on its own folder row pins it there (SUB-585)", async ({ page }) => {
  // the note already lives in Inbox, so this drop can't be a move — the
  // gesture reads "give it a sidebar row under Inbox"
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const note = page.locator(".row", { hasText: NOTE }).first();
  await note.dispatchEvent("dragstart", { dataTransfer });
  const inboxRow = page.locator(".side-folder", { hasText: "Inbox" });
  await inboxRow.dispatchEvent("dragover", { dataTransfer });
  await inboxRow.dispatchEvent("drop", { dataTransfer });

  const row = page.locator(".side-item", { hasText: NOTE });
  await expect(row).toBeVisible();
  // no flat section: the pin nested under the folder row
  await expect(page.locator(".side-section-toggle", { hasText: pinnedSection })).toHaveCount(0);
});

test("nested pins reorder by menu within their folder group", async ({ page }) => {
  // two pins under Inbox — its two plain fixtures render as plain rows
  const seeds: [string, string][] = [
    ["Inbox/Capture anything.md", "Capture anything"],
    ["Inbox/Vanished note.md", "Vanished note"],
  ];
  for (const [path, title] of seeds) {
    await page.locator(`.row[data-path="${path}"]`).click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Pin to sidebar" }).click();
    await expect(page.locator(".side-item", { hasText: title })).toBeVisible();
  }
  const pinTexts = async () => {
    const texts = await page.locator(".side-item .side-label-text").allTextContents();
    return texts.filter((t) => ["Capture anything", "Vanished note"].includes(t));
  };
  expect(await pinTexts()).toEqual(["Capture anything", "Vanished note"]);

  // Move up on the second pin swaps the pair; the order persists in
  // `$sidebar.pins` within the group
  await page.locator(".side-item", { hasText: "Vanished note" }).click({ button: "right" });
  await page.locator(".ctx-item", { hasText: "Move up" }).click();
  expect(await pinTexts()).toEqual(["Vanished note", "Capture anything"]);
});
