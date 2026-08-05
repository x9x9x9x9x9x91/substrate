import { expect, test, type Page } from "@playwright/test";

async function openAllNotes(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
}

test("primary list and Today rows expose separate keyboard controls (SUB-355)", async ({
  page,
}) => {
  await openAllNotes(page);

  const dbBlock = page.locator(".list").getByRole("button", { name: "Catalog", exact: true });
  expect(
    await dbBlock.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "DIV", tabIndex: 0 });
  await dbBlock.focus();
  await expect(dbBlock).toBeFocused();
  await dbBlock.press("Space");
  await expect(page.locator(".list-title")).toHaveText("Catalog");

  await page.locator(".side-item", { hasText: "All notes" }).click();
  const noteRow = page.locator(".list").getByRole("button", { name: "Welcome", exact: true });
  await noteRow.focus();
  // All notes is now a native button, so the preceding click leaves
  // Chromium in pointer modality. Round-trip with the keyboard before checking
  // :focus-visible — the ring is deliberately absent for pointer focus.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(noteRow).toBeFocused();
  await expect(noteRow).toHaveCSS("outline-style", "solid");
  await noteRow.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");

  // Existing global list navigation remains independent of the newly
  // focusable row controls: an arrow key changes selection and bare Enter
  // still moves into the selected note's editor. Welcome sorts last among the
  // loose rows (the Yield APR fixture left when the yield-apr dashboard kind
  // was retired), so step UP — the
  // direction with a guaranteed neighbor — then back DOWN to Welcome, the
  // known plain note, before entering the editor (its neighbors are sheets
  // and dashboards, whose panes aren't the note editor).
  await page.locator(".sidebar-title").click();
  const before = await page.locator(".list .row.selected").getAttribute("data-path");
  await page.keyboard.press("ArrowUp");
  const selected = page.locator(".list .row.selected");
  const after = await selected.getAttribute("data-path");
  expect(after).not.toBe(before);
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("data-path", before ?? "");
  const selectedTitle = await selected.getAttribute("aria-label");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(selectedTitle ?? "");
  await expect(page.getByRole("textbox", { name: "Note body" })).toBeFocused();

  await page.locator(".sidebar-title").click();
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".today-pane")).toBeVisible();
  const todayRow = page.locator(".today-row", { hasText: "Umbra listening session" });
  const openNote = todayRow.getByRole("button", {
    name: "Umbra listening session",
    exact: true,
  });
  const pick = todayRow.getByRole("button", { name: "Pick", exact: true });
  await expect(openNote).toBeVisible();
  await expect(pick).toBeVisible();
  await expect(openNote.locator("button")).toHaveCount(0);
  await openNote.focus();
  await expect(openNote).toBeFocused();
  await openNote.press("Space");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
    "Umbra listening session"
  );
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("note rows retain phone navigation with button semantics (SUB-355)", async ({ page }) => {
    await page.goto("/");
    const noteRow = page.locator(".list").getByRole("button", { name: "Welcome", exact: true });
    expect(
      await noteRow.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
    ).toEqual({ tag: "DIV", tabIndex: 0 });
    await noteRow.focus();
    await noteRow.press("Enter");
    await expect(page.locator(".list")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");
  });
});
