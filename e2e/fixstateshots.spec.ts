import { test, expect, type Page } from "@playwright/test";

// Evidence run — not a gate.
//   SHOTS=1 SHOT_DIR=/tmp/shots npx playwright test e2e/fixstateshots.spec.ts
//
// The state-truth surfaces a fix wave touched, each staged into the state the
// audits caught it in: an empty yield board, an empty jobs board, a task
// filter that matches nothing, a tax board whose source is broken while its
// cards read fine, metric cards bound at a sheet and a format that do not
// exist, a chart naming no database, and a view fence whose cut is empty.
//
// Two grounds, as the audit lanes took them. Dark is the app as it runs;
// "light" is the print pass — there is no runtime light theme, and
// `@media print` is what remaps the token ramp onto paper, so the clone into
// #print-surface asks the only light question the app has an answer to.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/1238c-shots";

async function shoot(page: Page, name: string, sel = ".note") {
  await expect(page.locator(sel).first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.locator(sel).first().screenshot({ path: `${DIR}/${name}-dark.png` });
  await page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    if (!pane) throw new Error(`no ${selector} to clone`);
    const box = pane.getBoundingClientRect();
    const clone = pane.cloneNode(true) as HTMLElement;
    clone.style.width = `${Math.round(box.width)}px`;
    clone.style.height = `${Math.round(box.height)}px`;
    const surface = document.createElement("div");
    surface.id = "print-surface";
    surface.appendChild(clone);
    document.body.appendChild(surface);
  }, sel);
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(200);
  await page.locator("#print-surface").screenshot({ path: `${DIR}/${name}-light.png` });
  await page.emulateMedia({ media: null });
  await page.evaluate(() => document.getElementById("print-surface")?.remove());
}

async function open(page: Page, title: string) {
  await page.locator(".side-item", { hasText: title }).first().click();
}

test.use({ viewport: { width: 1400, height: 900 } });

test("the state-truth surfaces, both grounds", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".side-item").first()).toBeVisible();

  // 1. yield: a board configured right and never logged into
  await page.evaluate(() =>
    window.__mockEditNote?.(
      "Dashboards/Yield APR.md",
      "Nothing logged yet.\n\n```csv\nat,yield_usd,principal_usd\n```\n",
    ),
  );
  await open(page, "Yield APR");
  await shoot(page, "yield-empty");

  // 2. jobs: prefixes no machine schedules anything under
  await page.evaluate(() =>
    window.__mockEditProp?.("Dashboards/Jobs.md", "prefixes", "com.nothing.here."),
  );
  await open(page, "Jobs");
  await shoot(page, "jobs-empty");

  // 3. tasks: an areas allowlist that matches none of the open work
  await page.evaluate(() => {
    window.__mockEditProp?.("Dashboards/Tasks.md", "areas", "No Such Area");
    window.__mockEditProp?.("Dashboards/Tasks.md", "view", "board");
  });
  await open(page, "Tasks");
  await shoot(page, "tasks-nomatch");

  // 4. tax: the source repointed at a note that is not a sheet, cards intact
  await page.evaluate(() =>
    window.__mockEditProp?.("Dashboards/Tax Readiness.md", "sheet", "Tax Readiness"),
  );
  await open(page, "Tax Readiness");
  await shoot(page, "tax-broken-source");

  // 5. metrics: one card at a sheet that isn't there, one at a format that
  //    isn't a format, one that reads fine — the row's own baseline test
  await page.evaluate(() =>
    window.__mockEditProp?.("Dashboards/Portfolio.md", "cards", [
      { label: "Nowhere", bind: "{{Nowhere.total}}", format: "eur" },
      { label: "Bad format", bind: "{{Holdings.total}}", format: "furlongs" },
      { label: "Positions", bind: "{{Holdings.positions}}", format: "number" },
      { label: "Total", bind: "{{Holdings.total}}", format: "eur", emph: true },
    ]),
  );
  await open(page, "Portfolio");
  await shoot(page, "metrics-misses");

  // 6. charts: a source naming no database, beside one that reads
  await page.evaluate(() =>
    window.__mockEditNote?.(
      "Dashboards/Releases/Label Health.md",
      "```chart\nsource: nosuchdb\nx: status\ny: count\ntitle: Missing database\n```\n\n" +
        "```chart\nsource: release\nx: status\ny: count\ntitle: A real one\n```\n",
    ),
  );
  await open(page, "Label Health");
  await shoot(page, "charts-unknown-db");
});
