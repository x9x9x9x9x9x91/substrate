import { expect, test, type Page } from "@playwright/test";

// Hub dashboard: a `dashboard: hub` note renders its ordinary
// markdown body column-first — `##` headings become section labels,
// consecutive callouts become cards side by side (the columns), everything
// else stays in linear flow. Fixture: Dashboards/Umbra Home.md
// (src/lib/tauri.ts) — one `## Releases` section, three callouts (one per
// kind) wikilinking Slow Bloom EP / Vessel Songs / Static Bouquet, then a
// paragraph and a table, then two ```view fences: a `type: contact`
// one that resolves to a live table, and a broken one that must fail in
// place. A later round adds a ```cards fence, a QUOTED cards fence and a chart+cards
// pair inside a callout body (all three must stay code boxes) and two ```chart
// fences (one sound, one with a broken `y:`) to the same fixture. The timeline fence adds
// one sound and one malformed ```timeline fence. Runs against the
// deterministic mock backend.

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
  await expect(page.locator(".hub-body .dash-table")).toHaveCount(2);
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
  // the fence is gone from the code-box path entirely — the page's four code
  // boxes are the deliberately quoted/nested fences, and none of them sits at
  // the top level of the body
  await expect(page.locator(".hub-body .hub-pre")).toHaveCount(4);
  await expect(page.locator(".hub-body > .hub-pre")).toHaveCount(0);
  await expect(page.locator(".hub-body .hub-pre", { hasText: "type:" })).toHaveCount(0);
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
  await expect(page.locator(".hub-body .dash-table")).toHaveCount(2);
  await expect(page.locator(".hub-body .hub-view .embed-view-table")).toHaveCount(1);
});

test("one hub body renders markdown, cards, chart, view and timeline fences together", async ({
  page,
}) => {
  await openHub(page);

  // markdown: the paragraph and the table from the top of the body
  await expect(page.locator(".hub-body .hub-p", { hasText: "linear flow" })).toBeVisible();
  await expect(page.locator(".hub-body .dash-table")).toHaveCount(2);

  // ```cards: the metrics strip, with the same cards the frontmatter form
  // would produce — resolved against the Holdings sheet, not fixture text
  const strip = page.locator(".hub-body .metrics-strip");
  await expect(strip).toHaveCount(1);
  const cards = strip.locator(".dash-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator(".dash-label")).toHaveText("Total value");
  await expect(cards.nth(0).locator(".dash-card-eur")).toHaveText(/€/);
  await expect(cards.nth(2).locator(".dash-label")).toHaveText("Positions");
  await expect(cards.nth(2).locator(".dash-card-eur")).toHaveText("4");
  // the emphasis cap is per page (principle 11): only the emph card keeps
  // the sharp voice, the other two sink
  await expect(strip.locator(".dash-card.sunk")).toHaveCount(2);

  // ```chart: the sound fence plots, with its title and provenance foot
  const chart = page.locator(".hub-body .hub-chart");
  await expect(chart).toHaveCount(2);
  const good = chart.first();
  await expect(good.locator(".dash-section-label")).toHaveText("Holdings by bucket");
  await expect(good.locator(".dash-bar-col")).toHaveCount(2);
  await expect(good.locator(".chart-err")).toHaveCount(0);

  // ```view: the live database table
  await expect(page.locator(".hub-body .hub-view .embed-view-table tbody tr")).toHaveCount(4);

  // ```timeline: the grouped horizontal time view; the malformed
  // one renders its parse error in place, never a code box
  await expect(page.locator(".hub-body .hub-timeline")).toHaveCount(1);
  await expect(page.locator(".hub-body .hub-timeline-err")).toHaveCount(1);

  // and none of them fell through to a top-level code box; the four code
  // boxes are deliberately nested in a quote/callout, never live fences
  await expect(page.locator(".hub-body .hub-pre")).toHaveCount(4);
  await expect(page.locator(".hub-body > .hub-pre")).toHaveCount(0);
});

test("a quoted ```cards fence stays a code box and takes no page slot (SUB-964)", async ({
  page,
}) => {
  await openHub(page);

  // a plain quote renders linear markdown: the fence inside it is quoted
  // TEXT, so it renders as a code box rather than a live strip
  const quoted = page.locator(".hub-body .hub-quote .hub-pre");
  await expect(quoted).toHaveCount(1);
  await expect(quoted).toContainText("label: Quoted");
  await expect(page.locator(".hub-body .hub-quote .metrics-strip")).toHaveCount(0);

  // and it consumed no slot: the real fence right below it still renders its
  // OWN three cards, not the quoted one's
  const strip = page.locator(".hub-body .metrics-strip");
  await expect(strip).toHaveCount(1);
  await expect(strip.locator(".dash-card")).toHaveCount(3);
  await expect(strip.locator(".dash-label").first()).toHaveText("Total value");
  await expect(strip).not.toContainText("Quoted");
});

test("chart, cards and progress fences inside a callout stay code boxes (SUB-964)", async ({
  page,
}) => {
  await openHub(page);

  const callout = page.locator(".hub-card-idea", { hasText: "Next up" });
  await expect(callout.locator(".hub-pre")).toHaveCount(3);
  await expect(callout.locator(".hub-pre").first()).toContainText("source: release");
  await expect(callout.locator(".hub-pre").nth(1)).toContainText("label: Nested");
  await expect(callout.locator(".hub-pre").nth(2)).toContainText("label: Nested goal");
  await expect(callout.locator(".hub-chart")).toHaveCount(0);
  await expect(callout.locator(".metrics-strip")).toHaveCount(0);
  // a live thermometer inside a quoted body would be a second dashboard
  // surface inside a card (progress fences follow the same rule)
  await expect(callout.locator(".hub-progress")).toHaveCount(0);
});

test("a malformed chart fence errors in place while its siblings render (SUB-964)", async ({
  page,
}) => {
  await openHub(page);

  // the broken `y:` fails where it sits, naming the mistake
  const err = page.locator(".hub-body .hub-chart .chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(/y must be count, sum:<prop> or avg:<prop>/);

  // the other three surfaces are untouched
  await expect(page.locator(".hub-body .metrics-strip .dash-card")).toHaveCount(3);
  await expect(page.locator(".hub-body .hub-chart .dash-bar-col").first()).toBeVisible();
  await expect(page.locator(".hub-body .hub-view .embed-view-table")).toHaveCount(1);
  await expect(page.locator(".hub-body .dash-table")).toHaveCount(2);
});

test("a timeline fence draws grouped bars, opens notes, and isolates malformed siblings (SUB-968)", async ({
  page,
}) => {
  await openHub(page);

  const timeline = page.locator(".hub-timeline");
  await expect(timeline).toHaveCount(1);
  await expect(timeline.locator(".hub-timeline-lane-label")).toContainText([
    "in review",
    "mastering",
  ]);
  await expect(timeline.locator(".hub-timeline-bar")).toHaveCount(2);
  await expect(timeline.locator(".hub-timeline-grid .today")).toHaveCount(1);

  const slowBloom = timeline.getByRole("button", { name: /Slow Bloom EP/ });
  await expect(slowBloom).toHaveAttribute("aria-label", /Jul 17, 2026.*Aug 1, 2026/);
  await slowBloom.click();
  await expect(page.locator(".note-title")).toHaveValue("Slow Bloom EP");

  await openHub(page);
  const err = page.locator(".hub-timeline-err");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(/missing required key "label"/);
  await expect(page.locator(".hub-view .embed-view-table")).toHaveCount(1);
  await expect(page.locator(".hub-chart .dash-bar-col").first()).toBeVisible();
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
