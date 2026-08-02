import { expect, test, type Page } from "@playwright/test";

// Hub dashboard (SUB-189): a `dashboard: hub` note renders its ordinary
// markdown body column-first — `##` headings become section labels,
// consecutive callouts become cards side by side (the columns), everything
// else stays in linear flow. Fixture: Dashboards/Umbra Home.md
// (src/lib/tauri.ts) — one `## Releases` section, three callouts (one per
// kind) wikilinking Slow Bloom EP / Vessel Songs / Static Bouquet, then a
// paragraph and a table, then two ```view fences (SUB-860): a `type: contact`
// one that resolves to a live table, and a broken one that must fail in
// place. Runs against the deterministic mock backend.

async function openHub(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");
}

test("hub renders the section label and one grid row of three kind-accented cards", async ({
  page,
}) => {
  await openHub(page);
  await expect(page.locator(".dash-section-label", { hasText: "Releases" })).toBeVisible();

  // exactly one card row holding exactly three cards, one per callout kind
  const grid = page.locator(".dash-cards.hub-cards");
  await expect(grid).toHaveCount(1);
  await expect(grid.locator(".dash-card")).toHaveCount(3);
  await expect(grid.locator(".hub-card-note")).toHaveCount(1);
  await expect(grid.locator(".hub-card-warn")).toHaveCount(1);
  await expect(grid.locator(".hub-card-idea")).toHaveCount(1);

  // the linear flow after the cards: the paragraph and the table render
  // full-width, wikilinks live inside them
  await expect(page.locator(".hub-body .hub-p", { hasText: "linear flow" })).toBeVisible();
  await expect(page.locator(".hub-body .dash-table")).toHaveCount(1);
  await expect(
    page.locator(".hub-body .dash-table .dash-link", { hasText: "Slow Bloom EP" })
  ).toHaveCount(1);
  // status cells wear the same schema pills as the database views — one
  // concept, one treatment (design principle 4)
  await expect(
    page.locator(".hub-body .dash-table .opt-pill", { hasText: "in review" })
  ).toHaveCount(1);
  await expect(
    page.locator(".hub-body .dash-table .opt-pill", { hasText: "mastering" })
  ).toHaveCount(1);
});

test("a card wikilink is a native keyboard control and follows to the target note", async ({
  page,
}) => {
  await openHub(page);
  const link = page.locator(".dash-card").getByRole("button", {
    name: "Vessel Songs",
    exact: true,
  });
  expect(
    await link.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
  ).toEqual({ tag: "BUTTON", tabIndex: 0 });
  await link.focus();
  await expect(link).toBeFocused();
  await link.press("Space");
  await expect(page.locator(".note-title")).toHaveValue("Vessel Songs");

  await openHub(page);
  const secondLink = page.locator(".dash-card").getByRole("button", {
    name: "Static Bouquet",
    exact: true,
  });
  await secondLink.focus();
  await secondLink.press("Enter");
  await expect(page.locator(".note-title")).toHaveValue("Static Bouquet");
});

test("a ```view fence renders a live database table, not a code box", async ({ page }) => {
  await openHub(page);
  const table = page.locator(".hub-body .hub-view .embed-view-table");
  await expect(table).toHaveCount(1);
  // the four mock `type: contact` notes — a real query result, not a fixture
  // string, and the type's own columns beside the Title one
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.locator("thead th").first()).toHaveText("Title");
  await expect(table.locator("thead th", { hasText: "role" })).toHaveCount(1);
  await expect(table.locator("tbody tr", { hasText: "booking" })).toHaveCount(1);
  // the fence is gone from the code-box path entirely
  await expect(page.locator(".hub-body .hub-pre")).toHaveCount(0);
});

test("a row title in a hub view fence opens the source note", async ({ page }) => {
  await openHub(page);
  const row = page.locator(".hub-view .embed-view-table tbody tr").first();
  const title = await row.locator(".embed-view-title .dash-link").textContent();
  await row.locator(".embed-view-title .dash-link").click();
  await expect(page.locator(".note-title")).toHaveValue(title ?? "");
});

test("a fence naming an unknown database fails in place, siblings unaffected", async ({
  page,
}) => {
  await openHub(page);
  // the error sits where the fence was — a quiet line, not a code box
  const err = page.locator(".hub-body .hub-view-err");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(/Unknown database/);
  // and the rest of the hub is untouched: cards, table, and the good fence
  await expect(page.locator(".dash-cards.hub-cards .dash-card")).toHaveCount(3);
  await expect(page.locator(".hub-body .dash-table")).toHaveCount(1);
  await expect(page.locator(".hub-body .hub-view .embed-view-table")).toHaveCount(1);
});

test("Open source note lands in the editor on the hub note's plain markdown", async ({
  page,
}) => {
  await openHub(page);
  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Umbra Home");
  // the source is ordinary markdown — the editor renders its callouts with
  // its own glyph idiom (the `> [!note]` syntax conceals off the active line)
  await expect(page.locator(".cm-callout-note").first()).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("In review");
});
