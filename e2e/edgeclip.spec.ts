import { test, expect, type Page } from "./fixtures";
import { openDb } from "./nav";
import { openSettings } from "./settings";

// Evidence + probe run — not a gate.
//   SHOTS=1 npx playwright test e2e/edgeclip.spec.ts
// Measures the five reported edge-clipping surfaces and shoots each at
// 1400×900 (the audit viewport) in both themes.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/sub-1001-shots/before";

const geom = (sel: string) => (page: Page) =>
  page.locator(sel).evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    maskImage: getComputedStyle(el).maskImage,
    cls: el.className,
  }));

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(150);
}

test.use({ viewport: { width: 1400, height: 900 } });

test("settings sheet", async ({ page }) => {
  await page.goto("/");
  await openSettings(page, "sharing");
  const body = page.locator(".shortcut-sheet-body");
  await expect(body).toBeVisible();
  await page.waitForTimeout(400);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/settings-${theme}.png` });
  }
  console.log("SETTINGS", JSON.stringify(await geom(".shortcut-sheet-body")(page)));
  const sheet = await page.locator(".shortcut-sheet").boundingBox();
  console.log("SHEET BOX", JSON.stringify(sheet));

  // the acceptance case: scrolled to the tab's last row, where the fade used
  // to dissolve the row it was meant to point at
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(250);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/settings-bottom-${theme}.png` });
  }
  console.log("SETTINGS@BOTTOM", JSON.stringify(await geom(".shortcut-sheet-body")(page)));
});

test("db table right edge", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Ledger");
  await page.waitForTimeout(400);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/dbtable-${theme}.png` });
  }
  console.log("DBTABLE", JSON.stringify(await geom(".db-body")(page)));
});

test("calendar upcoming rail", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Calendar" }).first().click();
  await expect(page.locator(".cal-agenda-body")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${DIR}/calendar-dark.png` });
  console.log("CALENDAR", JSON.stringify(await geom(".cal-agenda-body")(page)));
  await setTheme(page, "light");
  await page.screenshot({ path: `${DIR}/calendar-light.png` });
});

test("db manager sidebar", async ({ page }) => {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await expect(page.locator(".dbmgr-body")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/dbmgr-dark.png` });
  console.log("DBMGR", JSON.stringify(await geom(".dbmgr-body")(page)));
  console.log("SIDESCROLL", JSON.stringify(await geom(".sidebar-scroll")(page)));
});

test("dashboard overview", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".side-item")
    .filter({ has: page.getByText("Overview", { exact: true }) })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${DIR}/dashboard-dark.png` });
  const info = await page.evaluate(() => {
    const cands = [".note", ".dash-inner", ".pane-scroll", ".note-scroll"];
    return cands.map((s) => {
      const el = document.querySelector(s);
      if (!el) return { sel: s, missing: true };
      return {
        sel: s,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        cls: el.className,
      };
    });
  });
  console.log("DASHBOARD", JSON.stringify(info));
});

test("db manager at the height where its list overflows", async ({ page }) => {
  // the manager fits a 900px window, so the clipped case only shows up shorter
  await page.setViewportSize({ width: 1400, height: 600 });
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All databases" }).click();
  await page.waitForTimeout(500);
  const body = page.locator(".dbmgr-body");

  // mid-scroll: both fades live, and a row title dissolves into the top edge
  await body.evaluate((el) => {
    el.scrollTop = 25;
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${DIR}/dbmgr-mid-600.png` });
  console.log("DBMGR@MID", JSON.stringify(await geom(".dbmgr-body")(page)));

  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${DIR}/dbmgr-scrolled-600.png` });
  console.log("DBMGR@BOTTOM", JSON.stringify(await geom(".dbmgr-body")(page)));
});
