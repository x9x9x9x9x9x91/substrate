import { expect, test, type Page } from "./fixtures";

// The seeded AGENTS.md/CLAUDE.md stay real files (the mock indexes
// them like the engine does) but the app conceals them until Settings.md says
// `show-agent-files: true` — a fresh vault reads as the user's blank slate,
// not the tooling's. Settings.md itself is in the concealed set
// (the ⌘, sheet's "edit raw" opens it regardless). The toggle lives in the
// ⌘, sheet; the flag rides the same Settings.md read as `mod-hud`, so
// flipping it applies on the watcher echo without a restart.

function row(page: Page, title: string) {
  return page.locator(".list .row", { has: page.getByText(title, { exact: true }) });
}

async function bootAll(page: Page) {
  await page.goto("/");
  await page.locator(".side-item", { hasText: "All notes" }).click();
  await expect(page.locator(".list-title")).toHaveText("All notes");
}

test("app files are concealed from lists and palette by default (SUB-831, SUB-878)", async ({ page }) => {
  await bootAll(page);
  // seeded content is there, the app files are not
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "AGENTS")).toHaveCount(0);
  await expect(row(page, "CLAUDE")).toHaveCount(0);
  await expect(row(page, "Settings")).toHaveCount(0);

  // the scratch Notes view conceals them too (all three are typeless root
  // notes, which is exactly what that view lists)
  await page.locator(".side-item", { hasText: /^Notes/ }).click();
  await expect(page.locator(".list-title")).toHaveText("Notes");
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "AGENTS")).toHaveCount(0);
  await expect(row(page, "Settings")).toHaveCount(0);

  // palette: no note row may surface them — the "create" rows for the typed
  // query also contain the text, so match the row LABEL exactly
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-input").fill("AGENTS");
  await expect(
    page.locator(".palette-item-label", { hasText: /^AGENTS$/ })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("the settings toggle reveals them live, and re-conceals (SUB-831, SUB-878)", async ({ page }) => {
  await bootAll(page);
  // the toggle writes Settings.md and the watcher echo is what re-reads the
  // flag — the mock mirrors that cadence on request (same as modkeyhud.spec)
  await page.evaluate(() => window.__mockSetEchoOnWrites?.(true));

  await page.keyboard.press("Meta+,");
  const toggleRow = page.locator(".settings-row", { hasText: "Show app files" });
  await expect(toggleRow).toBeVisible();
  const sw = toggleRow.locator(".settings-switch");
  // default OFF — concealment is the resting state
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-sheet")).toHaveCount(0);

  // once the echo lands, all three files list like ordinary notes
  await expect(row(page, "AGENTS")).toBeVisible();
  await expect(row(page, "CLAUDE")).toBeVisible();
  await expect(row(page, "Settings")).toBeVisible();

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
  await expect(row(page, "Settings")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("AGENTS");
});

test("search totals don't count concealed app files (SUB-907)", async ({ page }) => {
  // "orientation" matches the mock AGENTS.md body plus 210 seeded title
  // matches — enough to overflow the 200-note page, which is where the count
  // surfaces: the truncated header quotes the ENGINE's total while the page
  // rows pass through the client's conceal filter. With the app files
  // concealed the engine must leave them out of that total, or the header
  // claims a note the user can never reach.
  await page.addInitScript(() => {
    const install = () => {
      const seed = (window as unknown as { __mockSeedMatching?: unknown }).__mockSeedMatching as
        | ((o: { folder: string; count: number; token: string; where: "title" | "body" }) => void)
        | undefined;
      if (!seed) return false;
      seed({ folder: "Bulk", count: 210, token: "orientation", where: "title" });
      return true;
    };
    if (!install()) {
      const t = setInterval(() => {
        if (install()) clearInterval(t);
      }, 5);
    }
  });
  await bootAll(page);
  await page.keyboard.press("Meta+Shift+f");
  await expect(page.locator(".search-input")).toBeFocused();
  await page.locator(".search-input").fill("orientation");
  // 210 seeded + AGENTS.md = 211 engine matches; concealed, the total the
  // header quotes must be the 210 the user can see. ("results", not "notes":
  // this vault has a mount, and the engine's total counts mounted files as
  // readily as notes — the number is what this test is about.)
  await expect(page.locator(".search-stats")).toHaveText("first 200 of 210 results");
});

test("edit raw opens Settings.md while it stays concealed (SUB-878)", async ({ page }) => {
  await bootAll(page);
  await expect(row(page, "Welcome")).toBeVisible();
  await expect(row(page, "Settings")).toHaveCount(0);

  // the ⌘, sheet's escape hatch works with the toggle OFF — concealment is
  // presentation, not access control
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "edit raw" }).click();
  await expect(page.locator(".settings-sheet")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Settings");
  // and the open note doesn't conjure a list row
  await expect(row(page, "Settings")).toHaveCount(0);
});
