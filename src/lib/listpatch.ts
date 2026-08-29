/* Keeping the note list current without re-listing the vault: how a patch
   folds into the list, and which of the overlapping answers in flight is
   allowed to land. Pure, and separate from the hook that drives it, so the
   ordering rules can be exercised directly. */
import type { NoteMeta } from "./types.ts";

/** Newest first, ties broken by path. The tie key is not decoration: the
    engine's index is a hash map, so two notes saved in the same millisecond
    used to come back in whatever order that map happened to iterate, and a
    patched list and a re-listed one stopped being the same list. Both sides
    order this way now, so a patch and a full list agree row for row. */
export function compareNotes(a: NoteMeta, b: NoteMeta): number {
  if (b.updated_ms !== a.updated_ms) return b.updated_ms - a.updated_ms;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Fold fetched metas into the list: the named paths leave, the ones that
    still exist come back with their fresh meta, and the result is re-sorted
    the way the engine's own list sorts. The sort is what makes a patched
    list and a re-listed one the same list, so it is not optional. */
export function patchNotes(
  prev: NoteMeta[],
  paths: string[],
  fetched: (NoteMeta | null)[]
): NoteMeta[] {
  const touched = new Set(paths);
  const next = prev.filter((n) => !touched.has(n.path));
  for (const meta of fetched) if (meta) next.push(meta);
  return next.sort(compareNotes);
}

/** A whole list landing after a patch that beat it home. The list is right
    about every path except the ones the newer patch already answered — it
    read those before the write — so those keep what the patch left, and that
    includes a row the patch removed. */
export function mergeList(
  prev: NoteMeta[],
  listed: NoteMeta[],
  newer: ReadonlySet<string>
): NoteMeta[] {
  if (newer.size === 0) return listed;
  const next = listed.filter((n) => !newer.has(n.path));
  for (const n of prev) if (newer.has(n.path)) next.push(n);
  return next.sort(compareNotes);
}

/**
 * Which refresh's answer each path in the list is currently showing.
 *
 * Refreshes overlap and are numbered when they are issued, so a later number
 * means a later read of the vault. A full list is the slow one: issued before
 * a patch, it can still land after it and put the pre-write rows back — and
 * the patch has already drained the paths that would have re-fetched them.
 *
 * The rule is deliberately per path rather than one "newest wins" number.
 * A patch answers only the handful of paths it asked about, so letting it
 * block every older refresh wholesale would throw away that refresh's news
 * about every other note in the vault — a stale row traded for a stale list.
 * A full list, on the other hand, answers every path at once, so it does
 * subsume every patch issued before it.
 */
export class RefreshOrder {
  /** the newest full list already applied — it spoke for every path */
  private listed = 0;
  /** path → the newest patch already applied to it, above `listed` */
  private byPath = new Map<string, number>();

  /** The refresh whose answer this path is showing. */
  private appliedFor(path: string): number {
    return Math.max(this.listed, this.byPath.get(path) ?? 0);
  }

  /** Take a patch that has just resolved: answers the subset of `paths` it
      may install, the rest already showing a later refresh's answer. */
  admitPatch(seq: number, paths: string[]): string[] {
    const fresh = paths.filter((p) => seq > this.appliedFor(p));
    for (const p of fresh) this.byPath.set(p, seq);
    return fresh;
  }

  /** Take a full list that has just resolved: answers the paths it must NOT
      overwrite (a newer patch got there first), or null if a newer list
      already landed and this one has nothing left to say. */
  admitList(seq: number): Set<string> | null {
    if (seq <= this.listed) return null;
    const newer = new Set<string>();
    for (const [path, at] of this.byPath) {
      if (at > seq) newer.add(path);
      // this list speaks for the path more recently than the patch did, so
      // the entry has served its purpose — the map stays burst-sized
      else this.byPath.delete(path);
    }
    this.listed = seq;
    return newer;
  }
}
