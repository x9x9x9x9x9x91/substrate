/* The settings sheet's tabs, in the order they render.

   Named for what they govern rather than for the code behind them — someone
   hunting the terminal's font looks under Terminal, and someone worried about
   what leaves the machine looks under Sharing. General is first because it
   holds the settings people come back to (the hotkeys); Experimental is last
   because it is the one place in here where a switch can change the app
   under you. */
export const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "sharing", label: "Sharing" },
  { id: "vault", label: "Vault" },
  { id: "experimental", label: "Experimental" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** The tabs a build actually shows.

    Experimental is the one tab whose whole contents can go missing: its only
    always-there toggle is macOS-only, and the rest of the list is unreleased
    and stripped out of the shared build — so a Linux or Windows reader of the
    shared build would see a tab in the strip that opens onto nothing. Every
    other tab has rows no build can take away. A strip that advertises a tab
    is a promise the sheet has to keep, so it asks first. */
export function visibleSettingsTabs(hasExperimental: boolean) {
  return SETTINGS_TABS.filter((t) => t.id !== "experimental" || hasExperimental);
}
