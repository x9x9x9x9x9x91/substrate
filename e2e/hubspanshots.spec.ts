import { expect, test } from "@playwright/test";

// Evidence run only: BEFORE/AFTER shots of a hub card row, with and without a
// callout that asked for the double-width card. Both grounds — the app has no
// runtime light theme, so "light" is the print surface.
test.skip(!process.env.SHOTS, "evidence run only");

const dir = "/tmp/hub-span";
const HUB = "Dashboards/Umbra Home.md";

const ROW = [
  "> [!note%SPAN%] Studio",
  "> Mixdown pass on Vessel this week, then the granular chain on the outro.",
  "> [!warn] Deadline",
  "> Master delivery due Friday.",
  "> [!idea] Later",
  "> Try the tape return on the drums.",
  "",
];

function body(span: string): string {
  return ["# Umbra Home", "", "## Now", "", ...ROW].join("\n").replace("%SPAN%", span);
}

async function open(page: import("@playwright/test").Page, span: string) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".dash-title")).toHaveText("Umbra Home");
  await page.evaluate(
    ([path, text]) => (window as unknown as { __mockEditNote: (p: string, b: string) => void }).__mockEditNote(path, text),
    [HUB, body(span)] as const
  );
  // reopen so the pane re-reads the note the way it would after an outside edit
  await page.locator(".side-item", { hasText: "Portfolio" }).first().click();
  await page.locator(".side-item", { hasText: "Umbra Home" }).click();
  await expect(page.locator(".hub-card")).toHaveCount(3);
  await page.waitForTimeout(800);
}

for (const [variant, span] of [["before", ""], ["after", "|span:2"]] as const) {
  test(`shot dark: ${variant}`, async ({ page }) => {
    await open(page, span);
    await page.screenshot({ path: `${dir}/${variant}-dark.png`, fullPage: true });
  });

  test(`shot light (print surface): ${variant}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await open(page, span);
    await page.locator("#root .dash-actions").getByRole("button", { name: "Print", exact: true }).click();
    await expect(page.locator("#print-surface .dash-inner")).toHaveCount(1);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/${variant}-light.png`, fullPage: true });
  });
}
