import { useEffect, useMemo, useRef, useState } from "react";
import { historyFreshness } from "../lib/ipc";
import { askFreshness, capStamps, factRefKey, freshCache } from "../lib/freshcache";
import type { FreshStamp } from "../lib/freshcache";
import type { EmbedResult } from "../lib/embeds";
import type { FactFreshness } from "../lib/types";

/* How old a surface's facts are.

   Pull-only and late: a surface renders what it has and fills its ages in
   when the history answers, because mining ages is the slow half and a table
   that waits for it is a table that flickers. Nothing here announces
   anything — an age appears where a reader asked for one, and nowhere else.

   A repaint costs nothing when nothing changed: the stamps are planned
   against the shared cache (lib/freshcache.ts) and only facts whose note moved
   on disk go down the wire. A surface with no facts to date makes no call at
   all.

   And an ask is never one big call. The history mutex is held for the length
   of a call's walk, and the vault watcher's batch handler — reindex,
   auto-snapshot, the reflex run — waits on that same lock, so a whole-vault
   ask sent in one piece stalls every background write until the walk is done.
   The chunking, the cap and the stop-on-unmount all live in `askFreshness`. */

/** What a surface knows about its facts' ages so far. `pending` is true only
    while a real ask is in flight, so a surface can say "reading the history"
    without ever showing that over an answer it already has. `unread` is how
    many facts the cap left out, so a surface can admit an incomplete read
    rather than presenting it as the whole vault. */
export interface FactAges {
  ages: Map<string, FactFreshness>;
  pending: boolean;
  unread: number;
}

/** The ages for a named set of facts, keyed by `factRefKey`. Empty until the
    history answers, and empty forever when history is off — a vault with no
    repository has no ages to give, and saying so quietly (a dash in the
    column) is the honest answer, not an error banner over the surface. */
function useFactAges(stamps: FreshStamp[]): FactAges {
  const [ages, setAges] = useState<Map<string, FactFreshness>>(new Map());
  const [pending, setPending] = useState(false);
  // the effect keys on WHICH facts at WHICH stamps, so a surface that
  // repaints for an unrelated reason re-runs nothing. Memoized on the array
  // identity: the join walks every fact, and the callers hand it a `useMemo`d
  // list that only changes when the vault or the schema does.
  const signature = useMemo(
    () => stamps.map((s) => `${s.path}\0${s.key}\0${s.updated_ms}`).join("\n"),
    [stamps]
  );
  const { asked, unread } = useMemo(() => capStamps(stamps), [stamps]);
  // a failed ask is not retried under the same signature: history being off
  // is a standing answer, and re-asking it on every repaint would be the
  // per-render walk this cache exists to prevent
  const failed = useRef<string | null>(null);

  useEffect(() => {
    if (asked.length === 0) {
      setAges(new Map());
      setPending(false);
      return;
    }
    let live = true;
    const { hits, misses } = freshCache.plan(asked);
    const show = (found: FactFreshness[]) => {
      if (!live) return;
      setAges(new Map(found.map((f) => [factRefKey(f.path, f.key), f])));
    };
    if (misses.length === 0 || failed.current === signature) {
      setPending(false);
      show(hits);
      return () => {
        live = false;
      };
    }
    setPending(true);
    // every chunk paints as it lands, so a big report fills in rather than
    // sitting empty for the length of the whole walk
    void askFreshness(misses, historyFreshness, (mined) => show([...hits, ...mined]), () => live)
      .catch(() => {
        failed.current = signature;
        show(hits);
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { ages, pending, unread };
}

/** Every fact a table's freshness columns are about. */
function stampsFor(result: EmbedResult): FreshStamp[] {
  if ("error" in result || !result.ages) return [];
  const props = Object.values(result.ages);
  return result.rows.flatMap((r) =>
    props.map((key) => ({ path: r.path, key, updated_ms: r.updated_ms }))
  );
}

/** The ages for one resolved table. A table with no freshness column asks
    for nothing at all. */
export function useFreshness(result: EmbedResult): Map<string, FactFreshness> {
  const stamps = useMemo(() => stampsFor(result), [result]);
  return useFactAges(stamps).ages;
}
