/** The gate in front of engine-backed reads.

    What it protects is invisible from inside the frontend: a plain Tauri
    command runs on the main thread, so a hidden window calling `vault_list`
    while the launch scan holds the engine lock parks the app and the boot
    frame never paints. The test that matters is therefore the negative one —
    the call must NOT go out before the index is up — and the positive one
    after it, since a gate that never opens is the same blank window by
    another route. */

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { mockBackend } from "./componentHarness.ts";
import type { MockWindow } from "./componentHarness.ts";

let win: MockWindow;

before(async () => {
  win = await mockBackend();
});

beforeEach(async () => {
  const { resetVaultReadyGate } = await import("./vaultReady.ts");
  resetVaultReadyGate();
  win.__mockSetVaultReady(true);
  win.__mockFail = new Set();
  win.__mockHang = new Set();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a ready backend opens the gate without holding anything up", async () => {
  const { whenVaultReady } = await import("./vaultReady.ts");
  let open = false;
  void whenVaultReady().then(() => {
    open = true;
  });
  await settle();
  assert.equal(open, true, "nothing to wait for: the index is already up");
});

test("a vault still indexing holds the read until `vault:ready` lands", async () => {
  win.__mockSetVaultReady(false);
  const { whenVaultReady } = await import("./vaultReady.ts");
  let open = false;
  void whenVaultReady().then(() => {
    open = true;
  });
  await settle();
  assert.equal(open, false, "the call would have parked the main thread");

  win.__mockEmit("vault:ready", null);
  await settle();
  assert.equal(open, true, "the index is up: reads go out");
});

test("the gate is asked once, not once per read", async () => {
  const { whenVaultReady } = await import("./vaultReady.ts");
  assert.equal(whenVaultReady(), whenVaultReady(), "one wait per window");
});

test("a scan that landed while the listener was registering still opens it", async () => {
  // The real sequence: the boot screen reads the status (not ready), and
  // `listen()` is a round trip of its own — so a scan finishing in between
  // fires `vault:ready` into nobody. Without the re-check the gate would
  // wait for an event that has already been and gone: a permanent skeleton.
  win.__mockSetVaultReady(false);
  const { bootStatus, whenVaultReady } = await import("./vaultReady.ts");
  await bootStatus(); // the answer the window will still be holding: not ready
  win.__mockSetVaultReady(true);
  win.__mockEmit("vault:ready", null); // nobody is subscribed yet

  let open = false;
  void whenVaultReady().then(() => {
    open = true;
  });
  await settle();
  await settle();
  assert.equal(open, true, "the index is up; only a re-read can find that out");
});

test("a backend with no `vault_ready` field is taken at its word: ready", async () => {
  win.__mockSetVaultReady(null);
  const { whenVaultReady } = await import("./vaultReady.ts");
  let open = false;
  void whenVaultReady().then(() => {
    open = true;
  });
  await settle();
  assert.equal(open, true, "an older backend scanned before answering anything");
});

test("a status call that errors opens the gate rather than stranding the window", async () => {
  win.__mockFail = new Set(["onboarding_status"]);
  const { whenVaultReady } = await import("./vaultReady.ts");
  let open = false;
  void whenVaultReady().then(() => {
    open = true;
  });
  await settle();
  assert.equal(open, true, "a wrong 'not ready' costs the whole app; a wrong 'ready' costs one call");
});

test("the boot status is one round trip, shared with the boot screen", async () => {
  const { bootStatus } = await import("./vaultReady.ts");
  assert.equal(bootStatus(), bootStatus(), "asked once per window");
});

test("a backend that never says ready opens the gate on its own", async () => {
  // The direction the backend cannot cover for itself — it marks ready even
  // when its boot thread unwinds, but a process that died mid-scan says
  // nothing at all, and a gate that never opens is the blank window back.
  const { whenVaultReady, setReadyCeilingForTests } = await import("./vaultReady.ts");
  setReadyCeilingForTests(20);
  try {
    win.__mockSetVaultReady(false);
    let open = false;
    void whenVaultReady().then(() => {
      open = true;
    });
    await settle();
    assert.equal(open, false, "still indexing, as far as anyone here knows");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(open, true, "the ceiling opened it");
  } finally {
    setReadyCeilingForTests();
  }
});

test("a status call that never comes back still opens the gate", async () => {
  // The case the ceiling is named for, and the one an errored status does NOT
  // cover: a command queued behind a blocked main thread never settles, so
  // every await in the gate's own setup hangs with it. If the ceiling is armed
  // after those awaits it never arms at all and the boot frame is up for good.
  const { whenVaultReady, setReadyCeilingForTests } = await import("./vaultReady.ts");
  setReadyCeilingForTests(20);
  try {
    win.__mockHang = new Set(["onboarding_status"]);
    let open = false;
    void whenVaultReady().then(() => {
      open = true;
    });
    await settle();
    assert.equal(open, false, "nothing has answered yet, and nothing will");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(open, true, "the ceiling armed before the awaits it protects");
  } finally {
    setReadyCeilingForTests();
  }
});
