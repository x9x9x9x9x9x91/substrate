import { test } from "node:test";
import assert from "node:assert/strict";

/* The mock backend lives behind `isTauri`, which sniffs `window` at module
   scope — shim one before importing so node lands on the mock lane (same
   trick as noteactions.test.ts); every app import below is dynamic for that. */
(globalThis as { window?: unknown }).window = globalThis;
const { vaultCreate, vaultSealNote, vaultUnlockSealedNote } = await import("./ipc.ts");
const {
  forgetSealed,
  holdSealed,
  isSealedUnlocked,
  relockSealed,
  releaseSealed,
  subscribeSealed,
  unlockedSealedPaths,
} = await import("./sealedsession.ts");

const engineUnlocked = () =>
  (globalThis as { __mockSealedUnlocked?: () => string[] }).__mockSealedUnlocked?.() ?? [];

/** A fresh sealed note, unlocked in the engine and registered as one hold —
    what a note pane leaves behind after the unlock dialog. */
async function sealedAndHeld(title: string): Promise<string> {
  const meta = await vaultCreate("", title, "");
  await vaultSealNote(meta.path, "correct horse battery");
  await vaultUnlockSealedNote(meta.path, "correct horse battery");
  holdSealed(meta.path);
  return meta.path;
}

test("holdSealed registers the note; releaseSealed drops the last hold and locks it", async () => {
  const path = await sealedAndHeld("sealed-release");
  assert.equal(isSealedUnlocked(path), true);
  assert.ok(unlockedSealedPaths().includes(path));

  releaseSealed(path);
  assert.equal(isSealedUnlocked(path), false);
  assert.ok(!engineUnlocked().includes(path), "the engine's authorization is gone too");
});

test("releaseSealed drops ONE holder — a second surface keeps the note readable", async () => {
  const path = await sealedAndHeld("sealed-two-holders");
  holdSealed(path);

  releaseSealed(path);
  assert.equal(isSealedUnlocked(path), true, "the other surface still holds it");
  // engine-side refcounting is the real backend's job (vault/mod.rs
  // `lock_sealed_note` saturating-decrements holders); the mock's unlocked set
  // is a plain Set, so only the frontend's own accounting is asserted here

  releaseSealed(path);
  assert.equal(isSealedUnlocked(path), false);
});

test("relockSealed locks the note for the whole session, whatever held it", async () => {
  const path = await sealedAndHeld("sealed-lock-now");
  holdSealed(path);

  // "Lock now" from a surface that never unlocked anything — the row menu.
  relockSealed(path);
  assert.equal(isSealedUnlocked(path), false);
  assert.ok(!engineUnlocked().includes(path), "every hold released, not just one");
});

test("relockSealed on a note nobody holds is a no-op", () => {
  relockSealed("never/unlocked.md");
  assert.equal(isSealedUnlocked("never/unlocked.md"), false);
});

test("forgetSealed drops the bookkeeping without touching the engine", async () => {
  const path = await sealedAndHeld("sealed-forget");
  forgetSealed(path);
  assert.equal(isSealedUnlocked(path), false);
  assert.ok(
    engineUnlocked().includes(path),
    "no lock command was sent — the caller already knows the engine dropped it",
  );
});

test("subscribers see every change, and unsubscribe stops them", async () => {
  let seen = 0;
  const off = subscribeSealed(() => {
    seen += 1;
  });
  const path = await sealedAndHeld("sealed-subscribe");
  assert.equal(seen, 1, "hold notified");
  relockSealed(path);
  assert.equal(seen, 2, "relock notified");
  off();
  holdSealed(path);
  assert.equal(seen, 2, "unsubscribed");
  relockSealed(path);
});

test("unlockedSealedPaths keeps one reference between changes", async () => {
  const before = unlockedSealedPaths();
  assert.equal(unlockedSealedPaths(), before, "stable for a useSyncExternalStore reader");
  const path = await sealedAndHeld("sealed-snapshot");
  assert.notEqual(unlockedSealedPaths(), before, "and a new one once the holds change");
  relockSealed(path);
});

test("a surface that only ADOPTS an unlock holds nothing, so its teardown releases nothing", async () => {
  const path = await sealedAndHeld("sealed-adopt");

  // What the note pane does on mount now: it reads the shared store to show
  // plaintext another surface authorized. The engine counts one holder per
  // unlock IPC and the pane ran none, so reading must not add a hold —
  // otherwise its teardown would lock a note the real holder is still editing.
  assert.equal(isSealedUnlocked(path), true, "the adopting surface sees the unlock");
  assert.deepEqual(unlockedSealedPaths().filter((p) => p === path), [path], "exactly one entry");

  // the adopting pane closes: it took nothing, so it releases nothing
  assert.ok(engineUnlocked().includes(path), "the original hold survives the adopting pane");

  // and the surface that DID unlock still owns the single release
  releaseSealed(path);
  assert.equal(isSealedUnlocked(path), false);
  assert.ok(!engineUnlocked().includes(path), "one hold, one release, engine back to locked");
});
