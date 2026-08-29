/** The meaning-search row after a download that never finished.
 *
 *  Quitting the app mid-fetch leaves part-files on disk: the model reads as
 *  bytes without being installed. The row used to render a disabled Download
 *  and no Remove in that state, which is a dead end — no control on it could
 *  get the machine to a working model again. So this holds the two things
 *  that make it recoverable: the control is enabled and says what it does,
 *  and pressing it actually downloads.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createElement as h } from "react";
import { mockBackend, renderComponent } from "./componentHarness.ts";

/* App modules are imported inside the tests — see the note in
   settingsPaneTabs.component.test.ts. */

before(async () => {
  const win = await mockBackend();
  // the mock world where a fetch was interrupted part-way through
  win.history.replaceState({}, "", "/?mockmeaning=interrupted");
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
  upcomingDock: "bottom" as const,
  setUpcomingDock: () => {},
};

test("an interrupted model download can be retried from the row", async (t) => {
  const { default: SettingsPane } = await import("../components/SettingsPane.tsx");
  const r = await renderComponent(t, h(SettingsPane, paneProps));
  await r.settle();

  const row = r.one("[data-testid='meaning-model-row']");
  assert.ok(row, "the meaning row should be on the General tab");
  assert.match(row.textContent ?? "", /interrupted at \d+%/, "the row should name the state it is in");

  const button = r.one("[data-testid='meaning-model-download']") as HTMLButtonElement | null;
  assert.ok(button, "an interrupted download should still offer a control");
  assert.equal(button.disabled, false, "the only control out of the dead end must be pressable");
  assert.match(button.textContent ?? "", /retry download/, "and say that it starts the fetch again");

  await r.click(button);
  await r.settle();

  // the mock's download command installs the model and emits the completion
  // tick — reaching "ready" is the proof the press reached the backend
  assert.match(
    r.one("[data-testid='meaning-model-row']")?.textContent ?? "",
    /ready/,
    "pressing retry should run the download command"
  );
  assert.ok(
    r.one("[data-testid='meaning-model-remove']"),
    "and leave the row in the installed state, with a way back out"
  );
});
