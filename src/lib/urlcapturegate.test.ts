/** The page-title switch on the standalone capture doors.

    Quick capture and the everywhere palette have no settings state of their
    own — they are separate windows with their own bundles — so they capture a
    pasted link through `urlCaptureGated`, which reads the switch itself. They
    used to call the command straight, and the command enriches unless told
    not to, so a vault with `net-link-titles: false` still reached the site
    from those two doors. */

import { test } from "node:test";
import assert from "node:assert/strict";

/* the mock backend lives behind `isTauri`, which sniffs `window` at module
   scope — shim one before importing so node lands on the mock lane */
(globalThis as { window?: unknown }).window = globalThis;
const { urlCaptureGated } = await import("./ipc.ts");

type MockHooks = {
  __mockEditProp?: (path: string, key: string, value: unknown) => void;
  __mockTraceCommands?: () => void;
  __mockReadCommandTrace?: () => { cmd: string; enrich?: boolean }[];
};
const win = globalThis as unknown as MockHooks;

/** the flag the last capture carried to the command */
async function captureWith(setting: unknown): Promise<boolean | undefined> {
  win.__mockEditProp?.("Settings.md", "net-link-titles", setting);
  win.__mockTraceCommands?.();
  await urlCaptureGated("https://example.com/a-page");
  const captures = (win.__mockReadCommandTrace?.() ?? []).filter((e) => e.cmd === "url_capture");
  assert.equal(captures.length, 1, "the link was captured once");
  return captures[0].enrich;
}

test("the switch off keeps a captured link from reaching the site", async () => {
  assert.equal(await captureWith("false"), false);
  assert.equal(await captureWith(false), false);
});

test("an unset or typo'd switch leaves the documented default", async () => {
  // netAllowed's rule: only an explicit false closes an outbound call, so a
  // vault that never wrote the key keeps the page titles it always had
  assert.equal(await captureWith(null), true);
  assert.equal(await captureWith("off"), true);
  assert.equal(await captureWith(true), true);
});
