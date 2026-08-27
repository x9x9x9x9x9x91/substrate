/* The mounts facet of a kind's ctx (vault-format §5.8).

   Here rather than inline in `CustomKindPane` for the reason `kindfx.ts` is:
   the shape is then pinnable without a render.

   A mounted folder is what a chart fence and a metric card already read
   (`dashboardMounts`), and a kind could not reach it at all — so a board that
   wanted to say how many files are in a watched folder had to be a built-in.
   These are that same data, read-only: the roster, and one mount's
   last-known index rows. No bind, no rescan, no annotate — the mount verbs
   stay behind the app's own surfaces, where the folder picker and the consent
   for touching disk live. */

import type { MountInfo, MountRow } from "./types.ts";
import type { DashboardMountState } from "./dashboardMounts.ts";

/** The mount roster, copied.

    A copy for the same reason `ctx.accents` is one: `readonly` is
    compile-time only and a bundle is a plain ES module, so a `.sort()` in
    vault code over the live array would reorder the list every other mount
    surface reads until reload. `globs` and `ignore` are copied too — the
    arrays are the ones `mounts_list` handed the app. */
export function kindMounts(mounts: MountInfo[]): MountInfo[] {
  return mounts.map((m) => ({
    ...m,
    globs: [...m.globs],
    ...(m.ignore ? { ignore: [...m.ignore] } : {}),
  }));
}

/** One mount's rows, or the sentence the pane refuses with.
 *
 *  Three answers, kept apart on purpose: rows, "there is no such mount", and
 *  "the mount is there and its index would not read". The last two must not
 *  look alike — an unreadable folder answering as an empty one is a board
 *  drawing "0 files" over a drive that is simply unplugged from the index. */
export function kindMountRows(
  name: string,
  state: DashboardMountState | undefined,
): { rows: MountRow[] } | { refusal: string } {
  if (!state) return { refusal: `no mount named “${name}”` };
  if ("error" in state) return { refusal: state.error };
  /* A copy per row, like the roster above — and `props` goes ALL the way down,
     not one level. The rows behind this door are the `dashboardMounts` cache's
     own, shared with every chart and card over the same folder in the same
     vault epoch, and a sidecar prop is arbitrary JSON: a tags list, a nested
     map. A one-level spread left those inner arrays aliased, so one `.push()`
     in vault code edited what the built-in surfaces beside it read. A row is
     plain JSON by construction, so `structuredClone` is the whole copy. */
  return { rows: state.rows.map((r) => ({ ...r, props: structuredClone(r.props) })) };
}
