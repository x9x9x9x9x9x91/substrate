import { expect, test } from "@playwright/test";

// The table menu: right-clicking a rendered table offers everything the table
// can do about the cell you hit — edit it in place, grow, delete this row or
// column, align this column. With the cursor in the table's source there is no
// grid to point at, so Cmd-Shift-M opens the same menu off the cursor.

const NOTE = "Inbox/Capture anything.md";

type Page = import("@playwright/test").Page;

/** Type a small table and step off it so the widget renders. */
async function typeTable(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("| Track | Length |\n| --- | --- |\n| Slug It Out | 6:12 |\n| Nod | 5:01 |");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-md-table")).toBeVisible();
}

const body = (page: Page) => page.evaluate((p) => window.__mockBodyOf!(p), NOTE);

/** Right-click a cell of the rendered table and wait for the menu. */
async function openOn(page: Page, text: string) {
  await page.locator(".cm-md-table td, .cm-md-table th").filter({ hasText: text }).first().click({
    button: "right",
  });
  await expect(page.locator(".ctx-menu")).toBeVisible();
}

const item = (page: Page, label: string) =>
  page.locator(".ctx-item").filter({ hasText: label }).first();

test("delete row takes out the row you right-clicked, and nothing else", async ({ page }) => {
  await typeTable(page);
  await expect(page.locator(".cm-md-table").last().locator("tbody tr")).toHaveCount(2);

  await openOn(page, "Slug It Out");
  await item(page, "Delete row").click();

  await expect.poll(() => body(page)).toContain("| Track | Length |\n| --- | --- |\n| Nod | 5:01 |");
  await expect.poll(() => body(page)).not.toContain("Slug It Out");
  // the table stayed rendered — deleting a row is not an invitation to edit source
  await expect(page.locator(".cm-md-table").last().locator("tbody tr")).toHaveCount(1);
});

test("the header row cannot be deleted, and says so instead of vanishing", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "Track");
  await expect(item(page, "Delete row")).toHaveClass(/disabled/);
  await item(page, "Delete row").click();
  await expect.poll(() => body(page)).toContain("| Track | Length |");
});

test("delete column takes the column out of every row", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "6:12");
  await item(page, "Delete column").click();

  await expect
    .poll(() => body(page))
    .toContain("| Track |\n| --- |\n| Slug It Out |\n| Nod |");
  await expect(page.locator(".cm-md-table").last().locator("th")).toHaveCount(1);
});

test("aligning a column writes the delimiter and the grid follows", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "Length");
  await item(page, "Align right").click();

  await expect.poll(() => body(page)).toContain("| --- | ---: |");
  const cell = page.locator(".cm-md-table").last().locator("tbody td").nth(1);
  await expect(cell).toHaveCSS("text-align", "right");

  // and choosing it again clears it — the menu marks the alignment in force
  await openOn(page, "Length");
  await expect(item(page, "Align right")).toContainText("✓");
  await item(page, "Align right").click();
  await expect.poll(() => body(page)).toContain("| --- | --- |");
});

test("edit cell rewrites one cell in place, with the grid still on screen", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "6:12");
  await item(page, "Edit cell").click();

  const editing = page.locator(".cm-md-table-cell-editing");
  await expect(editing).toBeVisible();
  await expect(editing).toHaveText("6:12");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("7:40");
  await page.keyboard.press("Enter");

  await expect.poll(() => body(page)).toContain("| Slug It Out | 7:40 |");
  // the table never collapsed to pipes — the point of editing in place
  await expect(page.locator(".cm-md-table")).toBeVisible();
  await expect(page.locator(".cm-md-table-cell-editing")).toHaveCount(0);
});

test("escape leaves the cell as it was", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "Nod");
  await item(page, "Edit cell").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Nodded");
  await page.keyboard.press("Escape");

  await expect.poll(() => body(page)).toContain("| Nod | 5:01 |");
  await expect.poll(() => body(page)).not.toContain("Nodded");
});

test("a pipe typed into a cell stays text instead of splitting the row", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "Nod");
  await item(page, "Edit cell").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Nod | Slug");
  await page.keyboard.press("Enter");

  await expect.poll(() => body(page)).toContain("| Nod \\| Slug | 5:01 |");
  await expect(page.locator(".cm-md-table").last().locator("th")).toHaveCount(2);
});

test("pasting two lines into a cell keeps it one line", async ({ page }) => {
  await typeTable(page);
  await openOn(page, "Nod");
  await item(page, "Edit cell").click();
  const editing = page.locator(".cm-md-table-cell-editing");
  await expect(editing).toBeVisible();
  await page.keyboard.press("Meta+a");

  // two rows off a spreadsheet: the cell has one line to give them
  await editing.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "Nod\nSlug It Out\n");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editing).toHaveText("Nod Slug It Out");
  await page.keyboard.press("Enter");

  await expect.poll(() => body(page)).toContain("| Nod Slug It Out | 5:01 |");
  // still four lines of table, not a row split in half
  await expect(page.locator(".cm-md-table").last().locator("tbody tr")).toHaveCount(2);
});

test("right-clicking the table's chrome opens no menu at all", async ({ page }) => {
  await typeTable(page);
  const before = await body(page);
  // the grow "+" and the frame around the grid are not cells: a menu opened
  // there used to aim at the header's first column, so "Delete column" took a
  // column the pointer never touched
  await page.locator(".cm-md-table-add-column").first().click({ button: "right", force: true });
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await page.locator(".cm-md-table-wrap").last().click({
    button: "right",
    position: { x: 2, y: 2 },
  });
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  expect(await body(page)).toBe(before);
});

test("a quoted table shows the menu and refuses it, quote intact", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Inbox/ }).click();
  await page.locator(".row-title", { hasText: "Capture anything" }).click();
  await expect(page.locator(".cm-content")).toContainText("This is the Inbox.");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  // the quote continuation types the "> " on the following lines itself
  await page.keyboard.type("> | Track | Length |\n| --- | --- |\n| Nod | 5:01 |");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(page.locator(".cm-md-table")).toBeVisible();
  const before = await body(page);

  await openOn(page, "5:01");
  for (const label of ["Edit cell", "Add row", "Delete row", "Delete column", "Align right"]) {
    await expect(item(page, label)).toHaveClass(/disabled/);
  }
  await item(page, "Delete column").click();
  await item(page, "Edit cell").click();

  // the quote is still a quote and the table still a table
  expect(await body(page)).toBe(before);
  await expect(page.locator(".cm-md-table-cell-editing")).toHaveCount(0);
});

/** Rewrite the open note from outside the app, the way a sync adopt does. */
async function externalRewrite(page: Page, body: string) {
  await page.evaluate(
    ([path, text]) => {
      window.__mockEditNote(path, text);
      window.__mockEmit?.("vault:changed", [path]);
    },
    [NOTE, body] as const
  );
}

test("a cell editor open across an external rewrite drops its edit", async ({ page }) => {
  await typeTable(page);
  // the typed table has to be on disk before an outside rewrite can be
  // adopted — a dirty buffer takes the conflict path instead
  await expect.poll(() => body(page)).toContain("| Nod | 5:01 |");
  await openOn(page, "6:12");
  await item(page, "Edit cell").click();
  await expect(page.locator(".cm-md-table-cell-editing")).toBeVisible();
  await page.keyboard.press("Meta+a");

  // the note is replaced whole while the box sits open: the coordinates the
  // editor captured now point at somebody else's characters. The adopt takes
  // the grid down with it, so the editor's own snapshot check is belt to that
  // braces — what this holds to is the outcome: nothing of the edit lands
  const adopted = "Rewritten from outside.\n\nNothing of the table is left.\n";
  await externalRewrite(page, adopted);
  await expect(page.locator(".cm-content")).toContainText("Rewritten from outside.");

  await page.keyboard.type("7:40");
  await page.keyboard.press("Enter");
  // the note reads as the outside rewrote it — no cell text spliced in at
  // coordinates that now belong to other words
  await expect(page.locator(".cm-content")).toHaveText(/^Rewritten from outside\.\s*Nothing of the table is left\.\s*$/);
  await expect.poll(() => body(page)).toBe(adopted);
});

test("a menu open across an external rewrite writes nothing", async ({ page }) => {
  await typeTable(page);
  await expect.poll(() => body(page)).toContain("| Nod | 5:01 |");
  await openOn(page, "Slug It Out");

  const adopted = "Rewritten from outside.\n\nStill no table here.\n";
  await externalRewrite(page, adopted);
  await item(page, "Delete row").click();

  await expect(page.locator(".cm-content")).toHaveText(/^Rewritten from outside\.\s*Still no table here\.\s*$/);
  await expect.poll(() => body(page)).toBe(adopted);
});

test("the keyboard opens the same menu with the cursor in the table's source", async ({ page }) => {
  await typeTable(page);
  // click into the table: it collapses to pipes, cursor on the clicked row
  await page.locator(".cm-md-table td").filter({ hasText: "5:01" }).first().click();
  await expect(page.locator(".cm-md-table")).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+m");
  await expect(page.locator(".ctx-menu")).toBeVisible();
  // no grid on screen, so no in-place cell editing — the source is already open
  await expect(page.locator(".ctx-item").filter({ hasText: "Edit cell" })).toHaveCount(0);

  await item(page, "Delete row").click();
  await expect.poll(() => body(page)).not.toContain("5:01");
  await expect.poll(() => body(page)).toContain("| Slug It Out | 6:12 |");
});

test("the shortcut stays out of the way outside a table", async ({ page }) => {
  await typeTable(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Meta+Shift+m");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
});
