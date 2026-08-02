import { expect, test, type Page } from "@playwright/test";

// SUB-831: the seeded AGENTS.md/CLAUDE.md stay real files (the mock indexes
// them like the engine does) but the app conceals them until Settings.md says
// `show-agent-files: true` — a fresh vault reads as the user's blank slate,
// not the tooling's. The toggle lives in the ⌘, sheet; the flag rides the
// same Settings.md read as `mod-hud`, so flipping it applies on the watcher
// echo without a restart.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function bootAll(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
}

test("agent files are concealed from lists and palette by default (SUB-831)", async ({ page }) => {
  await bootAll(page);
  // seeded content is there, the agent files are not
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "AGENTS")).toHaveCount(0);
  await expect(row(page, "CLAUDE")).toHaveCount(0);

  // the scratch Notes view conceals them too (both are typeless root notes,
  // which is exactly what that view lists)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "AGENTS")).toHaveCount(0);

  // palette: no note row may surface them — the "create" rows for the typed
  // query also contain the text, so match the row LABEL exactly
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("AGENTS");
  await expect(
    page.locator(".palette-item-label", { hasText: /^AGENTS$/ })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the settings toggle reveals them live, and re-conceals (SUB-831)", async ({ page }) => {
  await bootAll(page);
  // the toggle writes Settings.md and the watcher echo is what re-reads the
  // flag — the mock mirrors that cadence on request (same as modkeyhud.spec)
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));

  await page.keyboard.press("Meta+,");
  const toggleRow = page.locator(".settings-row", { hasText: "Show agent files" });
  await expect(toggleRow).toBeVisible();
  const sw = toggleRow.locator(".settings-switch");
  // default OFF — concealment is the resting state
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  // once the echo lands, both files list like ordinary notes
  await expect(row(page, "AGENTS")).toBeVisible();
  await expect(row(page, "CLAUDE")).toBeVisible();

  // and they open like ordinary notes
  await row(page, "AGENTS").click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("AGENTS");

  // flipping it back conceals again without stranding the app: the open
  // agent file stays open (same tolerance as Settings.md via "edit raw"),
  // but the rows are gone
  await page.keyboard.press("Meta+,");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(row(page, "AGENTS")).toHaveCount(0);
  await expect(row(page, "CLAUDE")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("AGENTS");
});
