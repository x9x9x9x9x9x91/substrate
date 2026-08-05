import { useEffect, useState } from "react";
import { kindsList } from "../lib/ipc";
import type { KindBundleInfo } from "../lib/kinds";

/* The installed custom kinds, shared by everything that shows them (SUB-961).

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
const listeners = new Set<() => void>();

/** Drop the shared list and re-fetch it everywhere it is on screen. Called
    after any write that changes what `kinds_list` would answer — enable,
    disable, trust — because the answer lives outside the vault and no epoch
    will report it. */
export function invalidateKindBundles(): void {
  cache = null;
  generation += 1;
  for (const l of [...listeners]) l();
}

/** `kinds_list`, or null while it is still in flight. Fetched only when
    `needed`, so the overwhelmingly common dashboard costs no round trip.

    `vaultEpoch` is optional because not every consumer has one: the dashboard
    passes it so a vault change re-reads the bundles, and the settings sheet —
    which is open for seconds and cares only about consent — omits it and takes
    whatever the cache holds. Omitting it must not evict the dashboard's entry;
    that would make opening settings a refetch for every pane on screen. */
export function useKindBundles(needed: boolean, vaultEpoch?: number): KindBundleInfo[] | null {
  const [bundles, setBundles] = useState<KindBundleInfo[] | null>(null);
  const [gen, setGen] = useState(generation);

  useEffect(() => {
    const bump = () => setGen(generation);
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
