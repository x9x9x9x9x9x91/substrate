import { vaultLockSealedNote } from "./ipc.ts";

/* Which sealed notes THIS app session still holds an unlock authorization
   for, and how many surfaces hold each.

   The engine refcounts holders and its contract is "the frontend locks
   exactly what it unlocked" (vault/mod.rs `lock_sealed_note`), so a surface
   that never unlocked a note must never call the lock command — releasing
   someone else's hold drops the identity out from under them. That was fine
   while the open note pane was the only door to seal/lock/unseal. It stops
   being fine the moment a row menu or the palette offers "Lock now": those
   surfaces did not unlock anything, and they need to know whether a note is
   authorized at all before they can honestly offer the verb.

   So the holds live here instead of inside one pane's ref. Every surface that
   unlocks registers the hold; every surface that leaves releases its own; and
   "Lock now" from anywhere calls `relockSealed`, which releases EVERY hold the
   session took — which is what a user asking to lock a note means, and which
   is still exactly the frontend locking what the frontend unlocked. Holders
   watching the note subscribe, so a pane showing plaintext returns to its lock
   screen the instant another surface relocks it. */

const holds = new Map<string, number>();
const listeners = new Set<() => void>();
/* Rebuilt only when the holds change, so a `useSyncExternalStore` reader gets
   a stable reference between notifications instead of a fresh array every
   render (which is an infinite loop, not a subscription). */
let snapshot: string[] = [];

function notify() {
  snapshot = [...holds.keys()].sort();
  for (const fn of [...listeners]) fn();
}

/** Watch for any change to the set of authorized notes. Returns the
    unsubscribe. */
export function subscribeSealed(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Record one surface's fresh authorization. Call it after
    `vaultUnlockSealedNote` resolves — one call per hold the surface keeps. */
export function holdSealed(path: string): void {
  holds.set(path, (holds.get(path) ?? 0) + 1);
  notify();
}

/** Drop ONE surface's authorization (a pane closing, a note switch). */
export function releaseSealed(path: string): void {
  const held = holds.get(path);
  if (held === undefined) return;
  if (held <= 1) holds.delete(path);
  else holds.set(path, held - 1);
  void vaultLockSealedNote(path);
  notify();
}

/** Lock the note for the whole session — release every hold taken for it.
    The verb behind "Lock now" wherever it is invoked from. */
export function relockSealed(path: string): void {
  const held = holds.get(path);
  if (held === undefined) return;
  holds.delete(path);
  for (let i = 0; i < held; i += 1) void vaultLockSealedNote(path);
  notify();
}

/** Forget the bookkeeping without asking the engine to lock anything — for
    the transitions where the engine has already dropped every authorization
    itself: unsealing (the note is plaintext again) and sealing (which leaves
    the note locked and holds nothing). */
export function forgetSealed(path: string): void {
  if (holds.delete(path)) notify();
}

export function isSealedUnlocked(path: string): boolean {
  return holds.has(path);
}

/** Every authorized path, sorted — what the row menu and the palette read to
    decide whether "Lock now" and "Remove seal…" can be offered without a
    password prompt. */
export function unlockedSealedPaths(): string[] {
  return snapshot;
}
