/** Mounts on a dashboard (SUB-982): the binding layer that lets a chart fence
 *  and a metric card read a mounted folder's live index the way they already
 *  read a database or a sheet.
 *
 *  A mount IS a schema type — the index stamps `type: <mount name>` on every
 *  row (src/lib/mounts.ts) — so `source: album-pool` needs no new fence
 *  grammar: it parses as a database source and resolves here instead of
 *  against the vault's notes. Cards reuse `{{Name.aggregate}}` unchanged, with
 *  the mount's aggregates standing where a sheet's summaries would.
 *
 *  Index shape, refresh and sidecars belong to the mounts foundation; this
 *  module only reads what `mount_rows` already returns.
 *
 *  Pure TS, no DOM/node imports: runs in the app and under `node --test`.
 *  Loading lives in src/lib/dashboardMounts.ts. */

import { dbRows, type ChartRow } from "./chart.ts";
import { formatFileSize } from "./display.ts";
import { fmtCard } from "./metriccards.ts";
import { rowMetas } from "./mounts.ts";
import type { MountInfo, MountRow } from "./types.ts";

/** A mount's rows as chart rows. The note pipeline's own converter does the
    work, so a charted mount sees exactly the columns its board shows —
    intrinsics (name, extension, size, created, modified, missing) merged under
    whatever the sidecars annotate — and nothing has two definitions. */
export function mountChartRows(mount: MountInfo, rows: MountRow[]): ChartRow[] {
  return dbRows(rowMetas(mount, rows), mount.name);
}

/** What a card can bind on a mount. Deliberately small and file-shaped: these
    are facts the index already holds about the folder, not a query language.
    Anything richer is a chart fence or a sheet. */
export const MOUNT_AGGREGATES = ["count", "missing", "present", "bytes", "newest", "oldest"] as const;

export type MountAggregate = (typeof MOUNT_AGGREGATES)[number];

export function isMountAggregate(name: string): name is MountAggregate {
  return (MOUNT_AGGREGATES as readonly string[]).includes(name.toLowerCase());
}

/** One aggregate over a mount's rows, or null when `name` isn't one of them.
    Counts are numbers (a card formats them); `newest`/`oldest` are the index's
    own modified stamps, so they read the way the board's column reads.
    A mount with no rows has no newest file — "" formats as the empty card,
    which is the honest answer rather than a fabricated date. */
export function mountAggregate(rows: MountRow[], name: string): number | string | null {
  switch (name.toLowerCase()) {
    case "count":
      return rows.length;
    case "missing":
      return rows.filter((r) => r.missing).length;
    case "present":
      return rows.filter((r) => !r.missing).length;
    case "bytes":
      return rows.reduce((n, r) => n + (r.missing ? 0 : r.size), 0);
    case "newest":
      return extremeModified(rows, 1);
    case "oldest":
      return extremeModified(rows, -1);
    default:
      return null;
  }
}

/** One aggregate's card text. `bytes` is a file size, and the board already
    has a voice for file sizes (`sizeLabel` → `formatFileSize`, src/lib/
    mounts.ts): the same folder must not read "11,8 MB" in its size column and
    "12.386.304" on a card above it. An explicit `format:` on the card still
    wins — asking for `number` is asking for the raw byte count — so the size
    formatter is the DEFAULT voice for `bytes`, not an override of intent. */
export function mountCardText(
  name: string,
  v: number | string,
  format?: string,
  digits?: number,
): string {
  if (name.toLowerCase() === "bytes" && !format && typeof v === "number") {
    return formatFileSize(v);
  }
  return fmtCard(v, format, digits);
}

/** The latest (`dir` 1) or earliest (`dir` -1) `modified` stamp in the index.
    Stamps are "YYYY-MM-DD HH:MM" — fixed width, so they compare as strings and
    no timezone enters a comparison that is only ever about the same folder. */
function extremeModified(rows: MountRow[], dir: 1 | -1): string {
  let best = "";
  for (const r of rows) {
    if (!r.modified) continue;
    if (best === "" || (dir === 1 ? r.modified > best : r.modified < best)) best = r.modified;
  }
  return best;
}
