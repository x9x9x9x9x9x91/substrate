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

  const err = page.locator(".dash-alert");
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
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".dash-state")).toContainText("4 charts");
  await expect(page.locator(".dash-section-label")).toHaveCount(4);
});

test("no dashboard: prop at all keeps the body scan", async ({ page }) => {
  // the legacy path, unchanged: chart fences make it a charts
  // dashboard with no key named anywhere
  await openOverview(page, null);
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".dash-state")).toContainText("4 charts");
  await expect(page.locator(".dash-section-label")).toHaveCount(4);
});

test("a dashboard note with no kind and no fence gets the help card", async ({ page }) => {
  // The other half of the same posture: a note that says `type: dashboard`
  // and nothing else has asked for no board in particular. It used to reach
  // the yield tracker — an APR instrument, its live currency fetch and its
  // "Log snapshot" form, standing in for "unconfigured".
  await page.goto("/");
  await page.evaluate((path) => {
    window.__mockTraceCommands?.();
    window.__mockEditProp?.(path, "dashboard", null);
    window.__mockEditNote?.(path, "Nothing configured here yet.\n");
  }, DASH);
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");

  const err = page.locator(".dash-alert");
  await expect(err).toHaveCount(1);
  await expect(err).toContainText("names no kind");
  // it names the way out: a kind to write, or a fence
  await expect(err).toContainText("chart, heatmap or calendar fence");
  await expect(err).toContainText("Known kinds:");
  await expect(err).toContainText("yield-apr");
  await expect(page.locator(".dash-state")).toHaveText("nothing configured");

  // no tracker: no APR hero, and no form to write a snapshot back into a note
  // whose author asked for none of it
  await expect(page.locator(".dash-apr")).toHaveCount(0);
  await expect(page.locator(".dash-form")).toHaveCount(0);
  // and no rates request went out on its behalf
  await page.waitForTimeout(150);
  const traced = (cmd: string) =>
    page.evaluate(
      (name) =>
        (window.__mockReadCommandTrace?.() as { cmd?: string }[]).filter((e) => e.cmd === name)
          .length,
      cmd
    );
  await expect.poll(() => traced("fx_rates")).toBe(0);
  // nor did anything write back into the note
  await expect.poll(() => traced("vault_write_body")).toBe(0);

  // the head still opens the source note — configuring it is the next move
  await page.locator(".dash-source").click();
  await expect(page.locator(".note-title")).toHaveValue("Overview");
});

test("dashboard: yield-apr still renders the tracker outright", async ({ page }) => {
  // the explicit key is untouched by the fallback change: the seeded board
  // draws its hero and keeps its snapshot form
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Yield APR" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Yield APR");
  await expect(page.locator(".dash-alert")).toHaveCount(0);
  await expect(page.locator(".dash-apr")).toHaveCount(1);
  await expect(page.locator(".dash-form")).toHaveCount(1);
});
