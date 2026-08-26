import { test, expect, type Page } from "./fixtures";
import { openDb } from "./nav";

// Evidence run — not a gate.
//   SHOTS=1 npx playwright test e2e/reviewwindowshots.spec.ts
// Shoots the property editor (the schema pane behind a column's "Edit
// schema…") in both grounds, so the Review window field can be judged against
// the rows it sits between.
test.skip(!process.env.SHOTS, "evidence run only");

const DIR = process.env.SHOT_DIR || "/tmp/sub1355-shots";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(150);
}

test.use({ viewport: { width: 1400, height: 900 } });

test("property editor", async ({ page }) => {
  await page.goto("/");
  await openDb(page, "Contact");
  // phone carries a window in the seed (1y), so the field renders prefilled
  await page.locator('.db-th-caret[title^="phone"]').click();
  await page.getByText("Edit schema…").click();
  const menu = page.locator(".selmenu").first();
  await expect(menu).toBeVisible();
  await page.waitForTimeout(300);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/propeditor-${theme}.png` });
  }
  const box = await menu.boundingBox();
  console.log("EDITOR BOX", JSON.stringify(box));
  console.log(
    "FIELDS",
    JSON.stringify(
      await page
        .locator(".selmenu .selmenu-add-input")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              placeholder: (el as HTMLInputElement).placeholder,
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              width: Math.round(r.width),
            };
          })
        )
    )
  );

  // and the same editor carrying a window, so the hint line is in frame
  const win = page.locator('.selmenu input[aria-label="Review window"]');
  await win.fill("yearly");
  await page.waitForTimeout(200);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/propeditor-window-${theme}.png` });
  }
  console.log("HINT", (await page.locator(".selmenu .selmenu-hint").last().textContent()) ?? "");

  // the empty state — no window is the default, and the placeholder has to
  // survive the menu's 240px column without clipping
  await win.fill("");
  await page.waitForTimeout(200);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/propeditor-empty-${theme}.png` });
  }
  console.log(
    "PLACEHOLDER CLIP",
    JSON.stringify(
      await win.evaluate((el) => ({
        scrollWidth: (el as HTMLInputElement).scrollWidth,
        clientWidth: (el as HTMLInputElement).clientWidth,
      }))
    )
  );

  await win.fill("sometimes");
  await page.waitForTimeout(200);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${DIR}/propeditor-refused-${theme}.png` });
  }
  console.log("WARN", (await page.locator(".selmenu .selmenu-warn").last().textContent()) ?? "");
  console.log(
    "SAVE DISABLED",
    await page.locator(".selmenu-btn", { hasText: "Save" }).isDisabled()
  );
});
