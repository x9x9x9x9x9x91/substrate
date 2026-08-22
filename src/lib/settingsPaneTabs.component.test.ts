/** The settings sheet, rendered, walked tab by tab.

    Splitting one long form into tabs is only an improvement if nothing fell
    out of the form on the way: a setting that is on no tab is reachable only
    by hand-editing the note, which is the thing this sheet exists to avoid.
    So the test walks every tab, collects every control it finds, and holds
    the union to exactly the set of keys the sheet declares.

    The one direction it can't close from here: a key documented in
    `vault-format.md` that the sheet never declared (`auto-sync` is one — it
    is settings-note config the Sync pane owns, not a row in here). What it
    does check is the other way round, that no row drifts out of the docs. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";

/* App modules are imported inside the tests, never at the top. The harness
   registers the loader that gives `src/` its vite semantics (`import.meta.env`
   among them) when IT evaluates, and ESM loads the whole static graph before
   evaluating any of it — so a static `import` of anything under src/ here gets
   the raw file and throws on the first `import.meta.env` it reaches. */

before(async () => {
  await mockBackend();
});

const paneProps = {
  onClose: () => {},
  onEditRaw: () => {},
  onSettingsChanged: () => {},
  onToast: () => {},
  vaultSealed: false,
  vaultSealPending: false,
  vaultSealUnconfirmed: false,
  onSealVault: () => {},
  onConfirmVaultSeal: () => {},
  onRejectVaultSeal: () => {},
  onRemoveVaultSeal: () => {},
  onCheckUpdates: () => Promise.resolve({ state: "current" as const }),
};

/** the controls on the tab currently showing, by settings key */
function keysOnTab(r: { all: (sel: string) => Element[] }): string[] {
  return r.all("[id^='set-']").map((e) => e.id.slice("set-".length));
}

test("every setting the sheet declares is reachable on exactly one tab", async (t) => {
  const { default: SettingsPane, SETTINGS_FIELD_TABS } = await import(
    "../components/SettingsPane.tsx"
  );
  const { visibleSettingsTabs } = await import("./settingsTabs.ts");
  const { visibleExperimentalToggles } = await import("./experimental.ts");
  const { vibrancyCapable } = await import("./vibrancy.ts");
  const { isTauri } = await import("./tauri.ts");
  const r = await renderComponent(t, h(SettingsPane, paneProps));
  await r.settle();

  /* Not the declared list: the Experimental tab is dropped in a build where
     nothing survives its filter, so what the strip owes is the tabs that have
     something on them. src/lib/settingsTabs.test.ts owns the emptied shape;
     here the harness reads as a Mac, so all six are expected. */
  const shown = visibleSettingsTabs(
    visibleExperimentalToggles(vibrancyCapable || !isTauri).length > 0
  );
  assert.equal(shown.length, 6, "the harness should see every tab");

  assert.deepEqual(
    r.all(".settings-tab").map((b) => b.textContent),
    shown.map((tab) => tab.label),
    "the strip renders every tab that has something on it, in order"
  );

  const seen = new Map<string, string[]>();
  for (const [index, tab] of shown.entries()) {
    await r.click(r.all(".settings-tab")[index]);
    await r.settle();
    const keys = keysOnTab(r);
    // Not every tab is made of declared fields: Vault is rows the pane renders
    // by hand (the vault it is pointed at, the seal), so what "this tab shows
    // something" means is a row, not a keyed control.
    assert.ok(
      r.all(".settings-row").length > 0,
      `the ${tab.label} tab renders nothing at all`
    );
    for (const key of keys) seen.set(key, [...(seen.get(key) ?? []), tab.id]);
  }

  // macOS-only rows are hidden off macOS rather than shown inert, so what the
  // harness should see depends on the same capability the sheet reads
  const expected = SETTINGS_FIELD_TABS.filter(
    (f) => f.only !== "macos" || vibrancyCapable
  ).map((f) => f.key);

  const missing = expected.filter((key) => !seen.has(key));
  assert.deepEqual(missing, [], "settings reachable on no tab");

  const doubled = [...seen].filter(([, tabsFor]) => tabsFor.length > 1);
  assert.deepEqual(doubled, [], "settings that render on more than one tab");

  for (const [key, tabsFor] of seen) {
    const declared = SETTINGS_FIELD_TABS.find((f) => f.key === key);
    if (!declared) continue; // the accessibility grant row and friends
    assert.equal(tabsFor[0], declared.tab, `${key} rendered on the wrong tab`);
  }
});

/* Fenced fields are exempt, on the same ground scripts/settings-seed.test.ts
   exempts them from the seeded Settings.md body: the vault format ships to the
   public mirror, and a key documented there that the reader's build has no
   field for is worse than an undocumented one. A field stops being exempt the
   moment its fence comes off.

   The marker is assembled rather than written out — this file ships to the
   mirror, and share-mirror.sh reads a surviving marker as a strip that failed. */
const STRIP_MARK = "share-mirror" + ":strip";

test("no row has drifted out of the vault-format docs", async () => {
  const { SETTINGS_FIELD_TABS } = await import("../components/SettingsPane.tsx");
  const docs = readFileSync(new URL("../../docs/vault-format.md", import.meta.url), "utf8");
  const unfenced = (src: string) =>
    src.replace(new RegExp(`${STRIP_MARK}-start[\\s\\S]*?${STRIP_MARK}-end`, "g"), "");
  const shared = unfenced(
    readFileSync(new URL("../components/SettingsPane.tsx", import.meta.url), "utf8")
  );

  // Experimental toggles are exempt for the reason their own note gives — they
  // change or disappear — which is also why the seeded Settings.md body has
  // never carried a bullet for one. The vault format documents what a vault
  // can rely on.
  const undocumented = SETTINGS_FIELD_TABS.map((f) => f.key)
    .filter((key) => !key.startsWith("experimental-"))
    .filter((key) => shared.includes(`key: "${key}"`))
    .filter((key) => !docs.includes(`\`${key}\``));
  assert.deepEqual(undocumented, [], "settings keys the sheet offers and the docs never mention");
});
