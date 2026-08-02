import { test, expect, type Page } from "@playwright/test";

// SUB-472: a rendered block widget used to be unreachable by keyboard —
// `Decoration.replace({block:true})` hides the positions it covers, so
// vertical motion stepped over the whole block and only a mouse click could
// reveal the source. Arrow keys now land on the block's near edge (down → its
// first line, up → its last), which is itself the reveal, and arrowing on out
// the far side re-renders it. Both block widgets are covered: the ```view
// embed (the filed bug) and the markdown table (same mechanism, same bug).

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

/** The line the cursor sits on, as text — the DOM selection is the truth here
 * (a revealed fence line is raw source, a rendered one has no text at all). */
async function cursorLine(page: Page): Promise<string> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel?.anchorNode) return "";
    const node = sel.anchorNode;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    return el?.closest(".cm-line")?.textContent ?? "";
  });
}

async function openUmbra(page: Page) {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Projects" }).click();
  await row(page, "Umbra").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");
  await expect(page.locator(".embed-view")).toBeVisible();
}

test("arrow keys reach the rendered ```view fence and leave it again (SUB-472)", async ({
  page,
}) => {
  await openUmbra(page);

  // click the paragraph below the fence, then arrow up towards it
  await page.locator(".cm-line", { hasText: "Rows open their note" }).click();
  await expect(page.locator(".embed-view")).toHaveCount(1);

  await page.keyboard.press("ArrowUp"); // the blank line under the fence
  await page.keyboard.press("ArrowUp"); // into the block → source revealed

  // the widget is gone and the fence is raw markdown again, cursor on its
  // last line (the edge we arrived at)
  await expect(page.locator(".embed-view")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("type: release");
  expect(await cursorLine(page)).toBe("```");

  // arrowing up walks the source line by line — before the fix the whole
  // block was skipped in one keypress
  await page.keyboard.press("ArrowUp");
  expect(await cursorLine(page)).toBe("view: table");
  await page.keyboard.press("ArrowUp");
  expect(await cursorLine(page)).toBe("query: status:mastering");
  await page.keyboard.press("ArrowUp");
  expect(await cursorLine(page)).toBe("type: release");
  await expect(page.locator(".embed-view")).toHaveCount(0);

  // ArrowDown passes back out the far side and the embed re-renders
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(page.locator(".embed-view")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  expect(await cursorLine(page)).toContain("Rows open their note");
});

test("arrowing down into the ```view fence reveals it from above (SUB-472)", async ({ page }) => {
  await openUmbra(page);

  await page.locator(".cm-line", { hasText: "Label hub for the Umbra" }).click();
  // the intro paragraph wraps, so the fence is a few visual lines down —
  // arrow until the embed opens, bounded so a skipping block still fails
  let presses = 0;
  while ((await page.locator(".embed-view").count()) > 0) {
    expect(presses++).toBeLessThan(6);
    await page.keyboard.press("ArrowDown");
  }

  // coming from above, the cursor lands on the block's first line
  await expect(page.locator(".embed-view")).toHaveCount(0);
  expect(await cursorLine(page)).toBe("```view");

  // and back up out the top re-renders it
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".embed-view")).toHaveCount(1);
});

test("mouse click still reveals the ```view fence source (SUB-472 regression)", async ({
  page,
}) => {
  await openUmbra(page);

  // clicking the embed body (not a row, not the header) drops the cursor in
  const embed = page.locator(".embed-view").first();
  await embed.locator(".embed-view-table tbody tr").first().hover();
  await page.locator(".cm-line", { hasText: "Rows open their note" }).click();
  await expect(page.locator(".embed-view")).toHaveCount(1);

  // header click still opens the database rather than revealing source
  await embed.locator(".embed-view-head").click();
  await expect(page.locator(".list-title")).toHaveText("Release");
});

test("arrow keys reach a rendered markdown table too (SUB-472)", async ({ page }) => {
  // same block-widget mechanism as the view fence — the hub note's source
  // ends with a two-row table
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra Home");
  await expect(page.locator(".cm-md-table")).toBeVisible();

  await page.locator(".cm-line", { hasText: "Everything below the cards" }).click();
  await page.keyboard.press("ArrowDown"); // blank line
  await page.keyboard.press("ArrowDown"); // into the table → raw source

  await expect(page.locator(".cm-md-table")).toHaveCount(0);
  expect(await cursorLine(page)).toBe("| release | status |");
  await expect(page.locator(".cm-table-line")).toHaveCount(4);

  // walk down through the rows, then out the bottom → rendered again
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  expect(await cursorLine(page)).toContain("Vessel Songs");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cm-md-table")).toHaveCount(1);
});
