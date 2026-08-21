import { expect, test, type Page } from "@playwright/test";

// Evidence run only: the surfaces containment changes — a healthy custom kind
// (unchanged, the regression check), the card a stalled mount now gets instead
// of a blank pane, the card a kind that wrote outside its element gets, and the
// card a blank `dashboard:` value gets instead of someone else's dashboard.
// The app has no runtime light theme; the light ground is the print pass, so
// each state is shot dark and then through #print-surface (see
// e2e/beforeshots.spec.ts).
test.skip(!process.env.SHOTS, "evidence run only");

const dir = process.env.SHOTS_DIR ?? "/tmp/kindcontain-shots";
// SHOTS_BEFORE captures the same states against a build without containment,
// where the card being waited for is the thing that does not exist yet.
const before = !!process.env.SHOTS_BEFORE;

const HEALTHY = `
export default {
  mount(el, ctx) {
    const h = document.createElement("div");
    h.className = ctx.css["dash-hero"];
    h.textContent = "gear rack: " + ctx.note.title;
    el.appendChild(h);
    ctx.setState({ label: "3 racks" });
  },
};
`;

const NEVER_SETTLES = `
export default {
  mount() { return new Promise(() => {}); },
};
`;

const ESCAPES_TO_BODY = `
export default {
  mount(el) {
    el.appendChild(document.createElement("p"));
    document.body.appendChild(document.createElement("div"));
  },
};
`;

const manifest = JSON.stringify({
  id: "gear-log",
  title: "Gear log",
  api: 1,
  entry: "index.js",
  description: "What is plugged into what.",
});

async function seed(page: Page, entry: string | null, dashboard: string) {
  await page.evaluate(
    async ([e, m, d]) => {
      if (e)
        await window.__mockWriteKind?.({
          id: "gear-log",
          manifest: m as string,
          files: { "index.js": e as string },
          enabled: true,
        });
      window.__mockEditProp?.("Dashboards/Overview.md", "dashboard", d as string);
    },
    [entry, manifest, dashboard] as const,
  );
  await page.locator(".side-item", { hasText: "Overview" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Overview");
}

const states = [
  { slug: "healthy", entry: HEALTHY, dashboard: "gear-log", card: false },
  { slug: "stalled-mount", entry: NEVER_SETTLES, dashboard: "gear-log", card: true },
  { slug: "wrote-outside", entry: ESCAPES_TO_BODY, dashboard: "gear-log", card: true },
  { slug: "blank-value", entry: null, dashboard: "   ", card: true },
];

// The runtime card is being renamed `.chart-err` -> `.dash-alert` alongside
// this work, so the locator accepts either until that lands.
for (const state of states) {
  test(`shot dark: ${state.slug}`, async ({ page }) => {
    await page.goto("/");
    await seed(page, state.entry, state.dashboard);
    if (state.card && !before)
      await expect(page.locator(".chart-err, .dash-alert")).toHaveCount(1, { timeout: 15000 });
    await page.waitForTimeout(before ? 7000 : 400);
    await page.screenshot({ path: `${dir}/${state.slug}-dark.png`, fullPage: true });
  });

  test(`shot light (print surface): ${state.slug}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await page.goto("/");
    await seed(page, state.entry, state.dashboard);
    if (state.card && !before)
      await expect(page.locator(".chart-err, .dash-alert")).toHaveCount(1, { timeout: 15000 });
    if (before) await page.waitForTimeout(7000);
    // the unknown-kind card carries no actions bar, so there is no print pass
    // to enter — that state's light ground is the live pane under print media
    const print = page.locator("#root .dash-actions").getByRole("button", {
      name: "Print",
      exact: true,
    });
    if (await print.count()) {
      await print.click();
      await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
    }
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/${state.slug}-light.png`, fullPage: true });
  });
}
