import { mountRows, mountsList } from "./ipc";
import { foldMountName } from "./mounts";
import type { MountInfo, MountRow } from "./types";

/** One charted/carded mount as a dashboard surface needs it: the mount's own
    state (bound here? folder present?) plus its last-known rows. A mount that
    isn't in `mounts.json` at all never lands here — the surface falls back to
    the vault's notes, since `source: release` naming a database and
    `source: album-pool` naming a mount share one grammar. */
export type DashboardMountState = { mount: MountInfo; rows: MountRow[] } | { error: string };

const cache = new Map<string, Promise<Map<string, DashboardMountState>>>();

function cacheKey(names: string[], vaultEpoch: number): string {
  const folded = [...new Set(names.map(foldMountName))].sort();
  return `${vaultEpoch}\u0000${folded.join("\u0000")}`;
}

/** Load the rows of every mount a dashboard binds, keyed by folded mount name.
    Shares the in-flight/result promise across surfaces the way dashboardSheets
    does: a note with three charts and a card strip over one mount
    costs one `mounts_list` + one `mount_rows` per mount, not one per surface.

    A name with no mount is simply absent from the result — the caller reads it
    as a database type instead. A mount whose rows fail to read becomes a named
    error rather than an empty plot, since an empty folder and an unreadable
    index must not look alike. */
export function dashboardMounts(
  names: string[],
  vaultEpoch: number,
): Promise<Map<string, DashboardMountState>> {
  const key = cacheKey(names, vaultEpoch);
  const hit = cache.get(key);
  if (hit) return hit;

  // the epoch keys the cache, so stale reuse is impossible; bound the retained
  // history the way the sheet cache does
  if (cache.size >= 64) cache.clear();

  const pending = (async () => {
    const result = new Map<string, DashboardMountState>();
    const wanted = new Set(names.map(foldMountName));
    if (wanted.size === 0) return result;
    const mounts = await mountsList();
    // Which mounts this board wants, first-wins on a folded-name collision —
    // decided before any read so the loop below has no ordering to preserve.
    const hits: MountInfo[] = [];
    const seen = new Set<string>();
    for (const mount of mounts) {
      const folded = foldMountName(mount.name);
      if (!wanted.has(folded) || seen.has(folded)) continue;
      seen.add(folded);
      hits.push(mount);
    }
    // A board over three mounts reads three indexes at once rather than
    // serially: the reads are independent, and the slowest one already bounds
    // the render. Failures stay per mount — one unreadable folder must not
    // take the other two down with it, so nothing here rejects.
    const loaded = await Promise.all(
      hits.map(async (mount): Promise<[string, DashboardMountState]> => {
        try {
          return [foldMountName(mount.name), { mount, rows: await mountRows(mount.id) }];
        } catch (error) {
          return [
            foldMountName(mount.name),
            { error: `“${mount.name}” could not be read: ${String(error)}` },
          ];
        }
      }),
    );
    for (const [folded, state] of loaded) result.set(folded, state);
    return result;
  })();
  // a rejected pass must not stay cached for the rest of the epoch — evict so
  // the next render retries
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  cache.set(key, pending);
  return pending;
}
