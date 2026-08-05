import { expect, test } from "@playwright/test";

// The table and ```view block widgets drove their whole interaction
// off a bare `mousedown` that never read `e.button`, so a right-click fired
// the primary action — a cell link opened the browser, an embed row navigated
// away, anything else collapsed the rendered widget to raw markdown. Both
// listeners now bail on a non-primary button, which leaves the right-click to
// the platform (native menu in the editor) exactly like a click on prose.

test("right-click on a rendered table cell leaves it rendered (SUB-657)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".note-title")).toHaveValue("Welcome");

  const table = page.locator(".cm-md-table");
  await expect(table).toBeVisible();

  // a plain cell: the collapse-to-source path
  await table.locator("td", { hasText: "chroma weather" }).click({ button: "right" });
  await expect(table).toBeVisible();
  await expect(page.locator(".cm-table-line")).toHaveCount(0);

  // a wikilink cell: must not follow the link
  await table.locator(".cm-wikilink", { hasText: "Static Bouquet" }).click({ button: "right" });
  await expect(page.locator(".note-title")).toHaveValue("Welcome");
  await expect(table).toBeVisible();

  // left-click still follows — the fix gates the button, not the behavior
  await table.locator(".cm-wikilink", { hasText: "Static Bouquet" }).click();
  await expect(page.locator(".note-title")).toHaveValue("Static Bouquet");
});

test("right-click on a table's external-link cell opens nothing (SUB-657)", async ({ page }) => {
  // the worst path in the bug: a right-click launched the browser. Record the
  // calls rather than the popup — the table stays rendered either way, so only
  // window.open tells the two behaviors apart.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    const real = window.open.bind(window);
    window.open = ((url?: string | URL, ...rest: unknown[]) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return real(url as string, ...(rest as [string?, string?]));
    }) as typeof window.open;
  });
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toBeFocused();
  await page.keyboard.type("Link table");
  await page.keyboard.press("Enter");

  await page.locator(".cm-content").click();
  await page.keyboard.insertText(
    "intro line\n\n| site | note |\n| --- | --- |\n| [example](https://example.com) | a link |\n"
  );
  // move the cursor off the table so the widget renders
  await page.locator(".cm-line", { hasText: "intro line" }).click();

  const table = page.locator(".cm-md-table");
  await expect(table).toBeVisible();

  const link = table.locator(".cm-cell-extlink", { hasText: "example" });
  await link.click({ button: "right" });
  await expect(table).toBeVisible();
  await expect(page.locator(".cm-table-line")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(
    []
  );

  // left-click still launches it (popup blocked in headless, the call is the
  // observable part)
  await link.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(
    ["https://example.com"]
  );
});

test("a table cell md-link keeps a parenthesized URL whole (SUB-912)", async ({ page }) => {
  // Fixed print + hub; the cell renderer is the third twin. The
  // destination must keep its one balanced paren level and the trailing ")"
  // must not leak into the cell text.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    const real = window.open.bind(window);
    window.open = ((url?: string | URL, ...rest: unknown[]) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return real(url as string, ...(rest as [string?, string?]));
    }) as typeof window.open;
  });
  await page.goto("/");
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await page.keyboard.press("Meta+n");
  await expect(page.locator(".note-title")).toBeFocused();
  await page.keyboard.type("Paren link table");
  await page.keyboard.press("Enter");

  await page.locator(".cm-content").click();
  await page.keyboard.insertText(
    "intro line\n\n| site | note |\n| --- | --- |\n| [wiki](https://en.wikipedia.org/wiki/Granular_(synthesis)) | a link |\n"
  );
  await page.locator(".cm-line", { hasText: "intro line" }).click();

  const table = page.locator(".cm-md-table");
  await expect(table).toBeVisible();
  const link = table.locator(".cm-cell-extlink", { hasText: "wiki" });
  await expect(link).toBeVisible();
  // the ")" belongs to the URL, not the cell text next to the link
  await expect(table.locator("td", { hasText: "wiki" })).not.toContainText(")");
  await link.click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(
    ["https://en.wikipedia.org/wiki/Granular_(synthesis)"]
  );
});

test("right-click on a view-embed row does not navigate (SUB-657)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-folder", { hasText: "Projects" }).click();
  await page.locator(".list .row", { has: page.getByText("Umbra", { exact: true }) }).click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra");

  const embed = page.locator(".embed-view");
  await expect(embed).toBeVisible();
  await expect(embed).toContainText("Vessel Songs");

  // a row: the openNote path
  await embed.locator(".embed-view-table tbody tr").first().click({ button: "right" });
  await expect(page.locator(".note-title")).toHaveValue("Umbra");
  await expect(embed).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("status:mastering");

  // the header: the openView path (pane would swap to the database)
  await embed.locator(".embed-view-head").click({ button: "right" });
  await expect(page.locator(".note-title")).toHaveValue("Umbra");
  await expect(embed).toBeVisible();

  // left-click on the header still opens the database
  await embed.locator(".embed-view-head").click();
  await expect(page.locator(".list-title")).toHaveText("Release");
});
