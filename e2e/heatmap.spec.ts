import { expect, test, type Page } from "@playwright/test";

// Heatmap fences: a ```heatmap fence draws one year of day squares
// over a database or a sheet. This spec covers the three shapes the feature
// ships in — a note that is nothing but heatmaps, a note that carries charts
// AND heatmaps, and a fence written into a hub body beside the other fences —
// plus the two failure modes: a malformed fence erroring in place, and a
// quoted fence staying a code box.
//
// Dates are FIXED in the fixture sheet rather than relative: a heatmap picks
// its year from the data, so a fixture that drifts across a new year would
// change which grid the assertions read.

// two years, so the year switch has something to switch between; a duplicate
// day (the two Jan 1 rows sum) and a non-numeric cell (skipped, and said so)
const SESSIONS = [
  "Studio sessions.",
  "",
  "```csv",
  "day,minutes",
  "2025-12-31,10",
  "2026-01-01,20",
  "2026-01-01,25",
  "2026-02-14,40",
  "2026-03-02,x",
  "```",
  "",
].join("\n");

const ONE_FENCE = ["```heatmap", "source: {{Holdings}}", "date: day", "value: sum:minutes", "```", ""].join(
  "\n",
);

// one chart and one heatmap in the same body — the composition both the
// keyless body scan and `dashboard: charts` must render whole
const CHART_AND_HEATMAP = [
  "```chart",
  "source: {{Holdings}}",
  "x: day",
  "y: sum:minutes",
  "kind: bar",
  "title: Minutes per day",
  "```",
  "",
  ONE_FENCE,
].join("\n");

async function openDash(page: Page, body: string, sheet = SESSIONS) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([s, b]) => {
      window.__mockEditNote!("Holdings.md", s);
      window.__mockEditNote!("Dashboards/Overview.md", b);
    },
    [sheet, body],
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("a heatmap fence draws the year its data lands in, summed per day (SUB-966)", async ({
  page,
}) => {
  await openDash(page, ONE_FENCE);

  // the pane is a heatmap dashboard: its own head, its own count
  await expect(page.locator(".dash-state")).toHaveText("1 heatmap");
  // the title is derived — a heatmap declares none
  await expect(page.locator(".dash-section-label")).toHaveText("Sum of minutes per day");

  // 2026 is the latest year with data, and every one of its days is a square
  // (not only the days that carry rows) so hover and the keyboard reach all of it
  await expect(page.locator(".heatmap-day")).toHaveCount(365);
  // the two days that carry minutes are the year's heaviest quarter
  await expect(page.locator('.heatmap-day[data-level="4"]')).toHaveCount(2);
  await expect(page.locator(".heatmap-day:not([data-level='0'])")).toHaveCount(2);

  // the readout says the year before anything is selected
  await expect(page.locator(".heatmap-readout")).toHaveText("2026 · 2 days with rows · 85 total");

  // provenance, and the row that could not be summed is reported rather than
  // quietly dropped
  await expect(page.locator(".dash-foot").first()).toHaveText("sheet: Holdings · 1 rows skipped");

  // a square states its day in the tooltip and to a screen reader
  const jan1 = page.locator(".heatmap-day").first();
  await expect(jan1).toHaveAttribute("title", "Jan 1, 2026 — 45 minutes · 2 rows");
  await expect(jan1).toHaveAttribute("aria-label", "Jan 1, 2026 — 45 minutes · 2 rows");
});

test("the grid is one tab stop and the arrows walk it (SUB-966)", async ({ page }) => {
  await openDash(page, ONE_FENCE);

  const grid = page.locator(".heatmap-grid");
  await grid.focus();
  const readout = page.locator(".heatmap-readout");

  // the first keypress lands on the newest day that carries rows, not on a
  // January corner the reader would have to walk out of
  await grid.press("ArrowDown");
  await expect(readout).toHaveText("Feb 14, 2026 — 40 minutes · 1 row");
  // and the cursor is carried by aria-activedescendant, never by DOM focus:
  // 365 squares must not become 365 tab stops
  await expect(page.locator(".heatmap-day.is-cursor")).toHaveCount(1);
  await expect(grid).toBeFocused();

  // down/up is a day, right/left a week — the columns
  await grid.press("ArrowDown");
  await expect(readout).toHaveText("Feb 15, 2026 — nothing");
  await grid.press("ArrowLeft");
  await expect(readout).toHaveText("Feb 8, 2026 — nothing");

  // Home and End are the year's ends, and the walk never leaves the year
  await grid.press("Home");
  await expect(readout).toHaveText("Jan 1, 2026 — 45 minutes · 2 rows");
  await grid.press("ArrowUp");
  await expect(readout).toHaveText("Jan 1, 2026 — 45 minutes · 2 rows");
  await grid.press("End");
  await expect(readout).toHaveText("Dec 31, 2026 — nothing");
});

test("a source spanning two years offers the switch, and switching redraws (SUB-966)", async ({
  page,
}) => {
  await openDash(page, ONE_FENCE);

  const years = page.locator(".heatmap-year");
  await expect(years).toHaveCount(2);
  await expect(years.nth(0)).toHaveText("2025");
  await expect(years.nth(1)).toHaveAttribute("aria-pressed", "true");

  await years.nth(0).click();
  await expect(years.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".heatmap-readout")).toHaveText("2025 · 1 day with rows · 10 total");
  await expect(page.locator('.heatmap-day[data-level="4"]')).toHaveCount(1);
});

test("a malformed heatmap fence errors in place while its siblings render (SUB-966)", async ({
  page,
}) => {
  await openDash(
    page,
    [
      ONE_FENCE,
      "```heatmap",
      "source: {{Holdings}}",
      "date: day",
      "value: nonsense",
      "```",
      "",
    ].join("\n"),
  );

  const err = page.locator(".dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(/value must be count or sum:<prop>/);
  // the sound fence beside it is untouched
  await expect(page.locator(".heatmap-grid")).toHaveCount(1);
  await expect(page.locator(".heatmap-day")).toHaveCount(365);
});

test("a note carrying charts and heatmaps renders both (SUB-966)", async ({ page }) => {
  await openDash(page, CHART_AND_HEATMAP);

  // the charts lead and keep the pane head; the heatmaps hang under them, so
  // neither kind goes unrendered for having been written second
  await expect(page.locator(".dash-state")).toHaveText("1 chart · 1 sheet");
  await expect(page.locator(".dash-chart .dash-bar-col")).toHaveCount(3);
  await expect(page.locator(".heatmap-grid")).toHaveCount(1);
  await expect(
    page.locator(".dash-section-label", { hasText: "Sum of minutes per day" }),
  ).toBeVisible();
});

test("`dashboard: charts` renders the heatmaps too (SUB-966)", async ({ page }) => {
  // naming the kind must read the body the same way the keyless scan does:
  // the keyed path used to drop every heatmap fence silently, so one body
  // rendered both fences with no prop and only the chart with `dashboard:
  // charts` written on it
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([sheet, body]) => {
      window.__mockEditNote!("Holdings.md", sheet!);
      window.__mockEditNote!("Dashboards/Overview.md", body!);
      window.__mockEditProp!("Dashboards/Overview.md", "dashboard", "charts");
    },
    [SESSIONS, CHART_AND_HEATMAP] as const,
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");

  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".dash-chart .dash-bar-col")).toHaveCount(3);
  await expect(page.locator(".heatmap-grid")).toHaveCount(1);
  await expect(
    page.locator(".dash-section-label", { hasText: "Sum of minutes per day" }),
  ).toBeVisible();
});

test("a hub body renders a heatmap fence beside its other fences (SUB-966)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate((body) => window.__mockEditNote!("Dashboards/Umbra Home.md", body), [
    "Label home.",
    "",
    "## Work",
    "",
    "```heatmap",
    "source: task",
    "date: due",
    "value: count",
    "query: status:todo",
    "```",
    "",
    "> A quoted heatmap fence is quoted text, not a grid:",
    "> ```heatmap",
    "> source: task",
    "> date: due",
    "> value: count",
    "> ```",
    "",
    "```heatmap year",
    "source: task",
    "date: due",
    "value: count",
    "```",
    "",
    "```heatmap",
    "source: task",
    "date: due",
    "value: nonsense",
    "```",
    "",
    "## People",
    "",
    "```view",
    "type: contact",
    "view: table",
    "```",
    "",
  ].join("\n"));
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");

  // both fences render where they were written — the sound one as a grid, the
  // broken one as an error in its own slot
  const heat = page.locator(".hub-body .hub-heatmap");
  await expect(heat).toHaveCount(2);
  await expect(heat.first().locator(".dash-section-label")).toHaveText("Task per day");
  await expect(heat.first().locator(".heatmap-grid")).toHaveCount(1);
  // the query is the filter-bar language, and the foot says which one ran
  await expect(heat.first().locator(".dash-foot")).toHaveText("database: task · status:todo");
  await expect(heat.first().locator(".dash-alert")).toHaveCount(0);

  const err = heat.nth(1).locator(".dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toHaveText(/value must be count or sum:<prop>/);

  // the quoted fence stayed a code box and consumed no slot, and the markdown
  // and view fence around all of it are untouched
  const quoted = page.locator(".hub-body .hub-quote .hub-pre");
  await expect(quoted).toHaveCount(1);
  await expect(quoted).toContainText("date: due");
  await expect(page.locator(".hub-body .hub-quote .heatmap-grid")).toHaveCount(0);

  // a TAILED opener is a code box too: the heatmap parser is strict bare-form,
  // so a tailed fence stays searchable prose (stripMachineFences leaves it) and
  // must not draw a live grid whose config would then sit in the index —
  // exactly two heatmaps rendered live above, the tailed one is the third pre
  const tailed = page.locator(".hub-body > .hub-pre");
  await expect(tailed).toHaveCount(1);
  await expect(tailed).toContainText("source: task");
  await expect(page.locator(".dash-section-label", { hasText: "Work" })).toBeVisible();
  await expect(page.locator(".hub-body .hub-view .embed-view-table")).toHaveCount(1);
});
