import { expect, test, type Page } from "./fixtures";

// Throwaway evidence run: the fence states this change separates — the
// untouched slash-menu scaffold, which used to render a parse error and now
// renders the calm "not filled in yet" card, and a fence whose config is
// actually wrong, which keeps the error band.
// The app has no runtime light theme; the light ground is the print pass, so
// each state is shot dark and then, where the pane has a print surface, on
// that surface.
//   SHOTS=1 npx playwright test e2e/heatmapscaffoldshots.spec.ts
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/heatmapscaffold-shots";
// SHOTS_BEFORE captures the same two notes against a build without this
// change, where the scaffold is a red parse error.
const before = !!process.env.SHOTS_BEFORE;

const SESSIONS = [
  "Studio sessions.",
  "",
  "```csv",
  "day,minutes",
  "2026-01-01,20",
  "2026-02-14,40",
  "```",
  "",
].join("\n");

// exactly what /heatmap writes into the note
const SCAFFOLD = [
  "```heatmap",
  "source: ",
  "date: ",
  "value: count",
  "# source: a database type, or {{Sheet Name}} for a sheet",
  "# date: the date property the squares sit on",
  "# value: count, or sum:<number prop>",
  "```",
  "",
].join("\n");

// config that is wrong rather than unwritten: a key heatmaps do not take
const WRONG = ["```heatmap", "source: {{Holdings}}", "date: day", "kind: bar", "```", ""].join("\n");

const states = [
  { slug: "scaffold-unfinished", body: SCAFFOLD, ready: before ? ".dash-alert" : ".dash-empty" },
  { slug: "wrong-config", body: WRONG, ready: ".dash-alert" },
];

async function open(page: Page, body: string) {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();
  await page.evaluate(
    ([s, b]) => {
      window.__mockEditNote!("Holdings.md", s);
      window.__mockEditNote!("Dashboards/Overview.md", b);
    },
    [SESSIONS, body],
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

for (const state of states) {
  test(`shot dark: ${state.slug}`, async ({ page }) => {
    await open(page, state.body);
    await expect(page.locator(state.ready).first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${state.slug}-dark.png`, fullPage: true });
  });

  test(`shot light (print surface): ${state.slug}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await open(page, state.body);
    await expect(page.locator(state.ready).first()).toBeVisible({ timeout: 15000 });
    const printer = page
      .locator("#root .dash-actions")
      .getByRole("button", { name: "Print", exact: true });
    test.skip((await printer.count()) === 0, "this pane has no print surface");
    await printer.click();
    await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${state.slug}-light.png`, fullPage: true });
  });
}
