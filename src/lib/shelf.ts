/* Drive Shelf copy: how a catalog talks about a disk that isn't here.
   Pure and now-injectable, so the pane and its tests spell staleness the same
   way — and so the one rule that matters is testable in isolation: EVERY
   number the shelf shows about an offline drive is a number from a catalog,
   and it is shown with the date that catalog was made. A shelf that renders
   a year-old file list without saying it is a year old is worse than no
   shelf. */

import { dateLocale } from "./dateLocale.ts";
import { ago, ageMs } from "./syncstory.ts";
import type { DriveEntry, DriveHit, DriveInfo } from "./types.ts";

/** Bytes at disk scale. `formatFileSize` stops at MB because a mount row is a
    file; a drive is four terabytes, and "4,000,000.0 MB" is not a size anyone
    reads. Same 1024 base, same one decimal. */
export function formatDriveSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = Math.max(0, bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  if (u === 0) return `${Math.round(n)} B`;
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: n < 10 ? 1 : 0,
    maximumFractionDigits: n < 10 ? 1 : 0,
  })} ${units[u]}`;
}

/** Past this, an age stops being a duration and becomes a date: "97d ago" is
    arithmetic, "last seen 12 May 2026" is a memory. */
const AGE_AS_DATE_MS = 30 * 24 * 60 * 60 * 1000;

/** A stamp as the shelf says it: "just now", "3h ago", or a plain date once
    it is old enough that counting days stopped helping. Empty stamp →
    "never", which is a real state (a drive another machine cataloged, that
    this vault has only ever read about). */
export function seenLabel(iso: string | undefined, now = Date.now()): string {
  const ms = ageMs(iso, now);
  if (ms === null) return "never";
  if (ms < 60_000) return "just now";
  if (ms < AGE_AS_DATE_MS) return ago(iso, now);
  // the vault's date dialect, not the machine's: a shelf row sits beside
  // dates the rest of the app writes from the dial
  return new Date(iso as string).toLocaleDateString(dateLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The one line under a drive's name. Online says where it is; offline says
    when it was last seen — never nothing, because a list of drives with no
    dates on it reads as a list of drives that are all still here. */
export function driveSubtitle(d: DriveInfo, now = Date.now()): string {
  const files = `${d.files.toLocaleString()} ${d.files === 1 ? "file" : "files"}`;
  const size = formatDriveSize(d.bytes);
  const capacity = d.total > 0 ? ` of ${formatDriveSize(d.total)}` : "";
  if (d.online) return `${files} · ${size}${capacity} · connected`;
  return `${files} · ${size}${capacity} · last seen ${seenLabel(d.last_seen, now)}`;
}

/** The staleness banner a drive's catalog carries while the disk is away, and
    `null` while it is here and current. Two separate honesty problems, in the
    order they bite: a catalog that is knowingly incomplete, and a catalog
    that describes a disk nobody has seen in a while. */
export function driveStaleness(d: DriveInfo, now = Date.now()): string | null {
  const parts: string[] = [];
  if (!d.online) {
    parts.push(
      `“${d.label}” isn’t connected — this is the catalog from ${seenLabel(d.scanned, now)}, not the disk.`
    );
  }
  if (d.capped > 0) {
    parts.push(
      `The last scan stopped at ${d.files.toLocaleString()} files and left another ${d.capped.toLocaleString()} out, so this catalog is incomplete.`
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/** Row class suffix for a catalogued file the last scan didn't find — the
    same greying-out a mount row gets, for the same reason. */
export function entryCls(e: DriveEntry): string {
  return e.missing ? " is-missing" : "";
}

/** A folder's line: what is inside it, since a folder has no date worth
    showing (its newest file's date would read as the folder's own). */
export function entrySubtitle(e: DriveEntry): string {
  if (!e.dir) return formatDriveSize(e.size);
  return `${e.files.toLocaleString()} ${e.files === 1 ? "file" : "files"} · ${formatDriveSize(e.size)}`;
}

/** Breadcrumbs for a browse path: each crumb's label and the prefix that
    goes back to it. Always starts at the drive itself (empty prefix). */
export function crumbs(prefix: string): { label: string; prefix: string }[] {
  const parts = prefix.split("/").filter(Boolean);
  const out: { label: string; prefix: string }[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ label: p, prefix: acc });
  }
  return out;
}

/** The prefix one level up, "" at the drive's root. */
export function parentPrefix(prefix: string): string {
  const parts = prefix.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/** Narrow one folder's entries by a typed filter — folders first either way,
    which is what makes a browse of 4000 sample folders navigable. */
export function filterEntries(entries: DriveEntry[], query: string): DriveEntry[] {
  const q = query.trim().toLowerCase();
  const kept = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  return [...kept].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** A search hit's provenance: which disk, and how old the answer is. Every
    hit carries it — an offline hit and an online one look alike otherwise,
    and only one of them is a claim about right now. */
export function hitProvenance(h: DriveHit, now = Date.now()): string {
  const where = h.online ? "connected" : `cataloged ${seenLabel(h.scanned, now)}`;
  return `${h.label} · ${where}`;
}

/** The folder a hit sits in, for the second line of a result row. */
export function hitFolder(h: DriveHit): string {
  const cut = h.rel.lastIndexOf("/");
  return cut > 0 ? h.rel.slice(0, cut) : "";
}

/** The sidebar row's one-line summary of a drive — here rather than in the
    pane so the rail and the shelf can never disagree about what "last seen"
    means, and so the rail doesn't import the pane to say it. */
export function shelfRowHint(d: DriveInfo, now = Date.now()): string {
  return d.online ? "connected" : `last seen ${seenLabel(d.last_seen, now)}`;
}
