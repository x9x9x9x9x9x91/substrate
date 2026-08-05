import { expect, test, type Page } from "@playwright/test";

// Unknown dashboard kinds: a `dashboard:` value the build doesn't
// render is an honest inline card naming the typo and the kinds that DO
// exist — the same quiet posture a ```view fence over an unknown database
// takes. It used to fall through to the yield tracker, so a typo answered
// with a financial instrument and its "Log snapshot" form, no error, no hint.
// The body-scan fallback survives, narrowed to notes that name no kind at all.
//
// Fixture: Dashboards/Overview.md (src/lib/tauri.ts) — a charts dashboard by
// body content, carrying no `dashboard:` prop, so one __mockEditProp stages
// each case without a seed per kind.

const DASH = "Dashboards/Overview.md";

async function openOverview(page: Page, kind: string | null) {
  await page.goto("/");
  await page.evaluate(
    ([path, value]) => window.__mockEditProp?.(path!, "dashboard", value),
    [DASH, kind] as const
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

test("an unknown dashboard kind renders the error card, never the yield tracker", async ({
  page,
}) => {
  await openOverview(page, "gear-log");

  const err = page.locator(".chart-err");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("unknown dashboard kind");
  await expect(err).toContainText("gear-log");
  // the card names what IS available — the typo is one glance from fixed
  await expect(err).toContainText("known kinds:");
  await expect(err).toContainText("tasks");
  await expect(page.locator(".dash-state")).toHaveText("unknown kind");

  // not the yield tracker: no APR hero, and above all no snapshot form
  await expect(page.locator(".dash-apr")).toHaveCount(0);
  await expect(page.locator(".dash-form")).toHaveCount(0);
  // and not the charts renderer either, though the body is full of fences
  await expect(page.locator(".dash-section-label")).toHaveCount(0);

  // the head still opens the source note — fixing the typo is the next move
  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Overview");
});

test("dashboard: charts dispatches to the charts renderer by name", async ({ page }) => {
  await openOverview(page, "charts");
  await expect(page.locator(".chart-err")).toHaveCount(0);
  await expect(page.locator(".dash-state")).toContainText("4 charts");
  await expect(page.locator(".dash-section-label")).toHaveCount(4);
});

test("no dashboard: prop at all keeps the body scan", async ({ page }) => {
  // the legacy path, unchanged: chart fences make it a charts
  // dashboard with no key named anywhere
  await openOverview(page, null);
  await expect(page.locator(".chart-err")).toHaveCount(0);
  await expect(page.locator(".dash-state")).toContainText("4 charts");
  await expect(page.locator(".dash-section-label")).toHaveCount(4);
});
