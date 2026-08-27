import { useEffect, useState } from "react";
import { kindsList } from "../lib/ipc";
import type { KindBundleInfo } from "../lib/kinds";

/* The installed custom kinds, shared by everything that shows them.

   Lifted out of DashboardPane because consent is now editable from two
   surfaces — the review pane and the settings section — and both have to
   agree the moment either changes something. The vault epoch alone can't
   carry that: enabling a kind writes to the app-config dir, not the vault, so
   nothing about the vault moves and a cache keyed only on the epoch would go
   on serving "disabled" until something unrelated happened to bump it. That
   was the difference between "enable, and it runs" and "enable, then reload".

   So: one in-flight promise per epoch, plus an explicit invalidation any
   consent write calls. Every mounted consumer re-fetches on both. */

let cache: { epoch: number; p: Promise<KindBundleInfo[]> } | null = null;
/** the last epoch a consumer that HAS one asked for, kept outside the cache so
    an invalidation doesn't lose it. Without this, an epoch-less consumer whose
    effect happens to run first after a write recreates the entry at epoch 0,
    and the dashboard's effect then sees a stale epoch and refetches — the
    eviction the doc comment below promises cannot happen. */
let lastEpoch = 0;
/** bumped by `invalidateKindBundles`; part of the effect's dependency list */
let generation = 0;
const listeners = new Set<(revoked: string | null) => void>();

/** Drop the shared list and re-fetch it everywhere it is on screen. Called
    after any write that changes what `kinds_list` would answer — enable,
    disable, trust — because the answer lives outside the vault and no epoch
    will report it.

    `revoked` names a kind whose consent record was just DELETED, and callers
    that withdraw consent must pass it. A refetch is a round trip, and until it
    lands every consumer goes on serving the roster it read before — on which
    that kind still reads "enabled". A pane reading it keeps the kind's code
    running, with the vault access consent buys, in a window where the record
    granting that access no longer exists. Naming the kind here closes the
    window: consumers drop its record the moment this is called, and the
    refetch only confirms what they already did.

    Deliberately one-directional. There is no `granted` twin: a withdrawal
    applied early is the app being stricter than the disk for a few frames,
    while a grant applied early would run unreviewed code off an IPC that
    might still fail. */
export function invalidateKindBundles(revoked?: string): void {
  cache = null;
  generation += 1;
  for (const l of [...listeners]) l(revoked ?? null);
}

/** `kinds_list`, or null while it is still in flight. Fetched only when
    `needed`, so a consumer with nothing to ask costs no round trip — and when
    several ask at once they share one, because the promise is cached per
    epoch rather than per caller.

    `vaultEpoch` is optional because not every consumer has one: the dashboard
    passes it so a vault change re-reads the bundles, and the settings sheet —
    which is open for seconds and cares only about consent — omits it and takes
    whatever the cache holds. Omitting it must not evict the dashboard's entry;
    that would make opening settings a refetch for every pane on screen. */
export function useKindBundles(needed: boolean, vaultEpoch?: number): KindBundleInfo[] | null {
  const [bundles, setBundles] = useState<KindBundleInfo[] | null>(null);
  const [gen, setGen] = useState(generation);

  useEffect(() => {
    const bump = (revoked: string | null) => {
      setGen(generation);
      /* The withdrawal lands here, a round trip before the refetch confirms
         it: the row keeps its manifest and loses only its consent record,
         which is what `resolveKindState` reads — so the kind resolves to
         "not enabled", every pane showing it tears its code down, and the
         fresh list arrives to a surface that already stopped. */
      if (revoked !== null)
        setBundles((prev) =>
          prev === null
            ? prev
            : prev.map((b) =>
                b.id === revoked && b.record !== undefined ? { ...b, record: undefined } : b
              )
        );
    };
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  useEffect(() => {
    if (!needed) return;
    let gone = false;
    if (vaultEpoch !== undefined) lastEpoch = vaultEpoch;
    if (!cache || (vaultEpoch !== undefined && cache.epoch !== vaultEpoch)) {
      cache = { epoch: lastEpoch, p: kindsList() };
    }
    const mine = cache;
    mine.p
      .then((rows) => {
        if (!gone) setBundles(rows);
      })
      .catch((e) => {
        // A backend that can't list bundles is not a reason to fall back to a
        // yield tracker: an empty list keeps the named kind on the
        // unknown-kind card, which is what the user can act on.
        console.error("kinds_list failed", e);
        if (cache === mine) cache = null;
        if (!gone) setBundles([]);
      });
    return () => {
      gone = true;
    };
  }, [needed, vaultEpoch, gen]);

  return needed ? bundles : null;
}
