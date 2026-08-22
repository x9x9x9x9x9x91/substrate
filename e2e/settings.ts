import { expect, type Page } from "@playwright/test";
// the sheet's own tab list, so a seventh tab reaches these helpers and the
// walks below them without anyone remembering to widen a copy of it here
import type { SettingsTabId } from "../src/lib/settingsTabs";

// The ⌘, sheet is tabbed, so "open settings" is now two moves: raise the
// sheet, then pick the tab the row lives on. Specs say which tab they mean
// rather than scrolling for a label — a row that moved tabs then fails as
// "not on the tab you named", which is the honest error.
export type SettingsTab = SettingsTabId;

export async function settingsTab(page: Page, tab: SettingsTab) {
  const button = page.locator(`#settings-tab-${tab}`);
  await button.click();
  await expect(button).toHaveAttribute("aria-selected", "true");
}

/** the gear in the lower-left tools row, then the tab (General shows by
    default, so naming it is free) */
export async function openSettings(page: Page, tab: SettingsTab = "general") {
  await page.locator(".side-tools").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-sheet")).toBeVisible();
  if (tab !== "general") await settingsTab(page, tab);
}

/** same sheet, raised by the hotkey — the flows that were already pressing
    ⌘, keep pressing it */
export async function openSettingsByKey(page: Page, tab: SettingsTab = "general") {
  await page.keyboard.press("Meta+,");
  await expect(page.locator(".settings-sheet")).toBeVisible();
  if (tab !== "general") await settingsTab(page, tab);
}
