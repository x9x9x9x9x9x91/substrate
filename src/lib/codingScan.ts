/* Coding dashboard: types for the `coding_scan` command's payload
   (field names match the Rust coding::CodingScan serde verbatim), plus the
   attention sort + formatters the table renders by. Pure module — the
   invoke wrapper lives in ipc.ts (`codingScan`) so node --test can import
   this without the Tauri backend. */

import { numberLocale, type NumberLocale } from "./numberLocale.ts";

export interface CodingRepo {
  name: string;
  disk_bytes: number;
  current_branch: string;
  dirty_files: number;
  last_commit_unix: number | null;
  last_commit_subject: string;
  branch_total: number;
  integration_branch: string;
  lanes_unmerged: number;
  lanes_oldest_unix: number | null;
  worktree_count: number;
  ahead: number | null;
  behind: number | null;
  error: string | null;
}

export interface CodingOther {
  name: string;
  disk_bytes: number;
  newest_mtime_unix: number | null;
}

export interface CodingScan {
  scanned_unix: number;
  dir: string;
  missing: boolean;
  /** the root names a store the app may never read (`~/.ssh` and friends) —
      an empty state, not an error */
  denied: boolean;
  /** the scan's sizing budget ran out: the disk numbers are floors */
  sizes_partial: boolean;
  repos: CodingRepo[];
  others: CodingOther[];
}

/** an unmerged lane is stale after this many seconds (4 days) */
const LANE_STALE_SECS = 4 * 86_400;

/** rows that float to the top: broken, dirty, behind, or harbouring a lane
    untouched for 4+ days */
export function needsAttention(r: CodingRepo, nowUnix: number): boolean {
  if (r.error) return true;
  if (r.dirty_files > 0) return true;
  if (r.behind !== null && r.behind > 0) return true;
  if (
    r.lanes_unmerged > 0 &&
    r.lanes_oldest_unix !== null &&
    nowUnix - r.lanes_oldest_unix > LANE_STALE_SECS
  )
    return true;
  return false;
}

/** attention rows first, each group by last commit (newest first); repos
    that never committed sink to the end of their group */
export function sortCodingRepos(repos: CodingRepo[], nowUnix: number): CodingRepo[] {
  return [...repos].sort((a, b) => {
    const rank = (r: CodingRepo) => (needsAttention(r, nowUnix) ? 0 : 1);
    const key = (r: CodingRepo) => r.last_commit_unix ?? 0;
    return rank(a) - rank(b) || key(b) - key(a);
  });
}

/** Human disk size in the dial's dialect. The decimal separator was
    a hand-rolled `.replace(".", ",")`, which is German whatever the dial says;
    `toLocaleString` is the same call every other formatter makes. The whole-
    number branches go through it too — a 1023 KB or 1023 MB row groups under
    fr-FR and en-US, and `1023 KB` there would be the same bug one digit over.

    `locale` defaults to the module binding rather than being threaded, like
    `formatFileSize`: the table's caller subscribes to the dial for its repaint.
    Tests pass it explicitly so a pinned string names the dialect it asserts. */
export function fmtBytes(bytes: number, locale: NumberLocale = numberLocale()): string {
  if (bytes >= 2 ** 30) {
    const gb = (bytes / 2 ** 30).toLocaleString(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return `${gb} GB`;
  }
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20).toLocaleString(locale)} MB`;
  return `${Math.max(1, Math.round(bytes / 2 ** 10)).toLocaleString(locale)} KB`;
}

/** compact relative age of a unix-seconds stamp: "12m ago", "5h ago",
    "9d ago"; "—" when absent */
export function fmtAgeUnix(unix: number | null, nowUnix: number): string {
  if (unix === null) return "—";
  const s = Math.max(0, nowUnix - unix);
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** age in whole days, for the stale-lane cell */
export function ageDays(unix: number, nowUnix: number): number {
  return Math.max(0, Math.floor((nowUnix - unix) / 86_400));
}
