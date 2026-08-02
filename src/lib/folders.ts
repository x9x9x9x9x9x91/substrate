import type { FolderScanStats } from "./types";

/** One-line toast summary of a folder-database rescan. */
export function scanSummary(stats: FolderScanStats[]): string {
  if (stats.length === 0) return "No folder mappings in .vault/folders.json";
  const sum = (k: "created" | "updated" | "missing") =>
    stats.reduce((n, s) => n + (s.error ? 0 : s[k]), 0);
  const parts: string[] = [];
  const created = sum("created");
  const updated = sum("updated");
  const missing = sum("missing");
  if (created) parts.push(`${created} new`);
  if (updated) parts.push(`${updated} updated`);
  if (missing) parts.push(`${missing} missing`);
  let base = parts.length
    ? `Folder scan: ${parts.join(" · ")}`
    : "Folder scan: everything up to date";
  const bad = stats.filter((s) => s.error).length;
  if (bad) base += ` · ${bad} folder${bad === 1 ? "" : "s"} unreadable`;
  return base;
}

/** One mapping's scan outcome as an inline line — the "Map a folder…"
    dialog's result area (SUB-672). A stat's `error` reports separately. */
export function scanStatLine(s: FolderScanStats): string {
  return `${s.created} ${s.created === 1 ? "note" : "notes"} created, ${s.updated} updated, ${s.missing} missing`;
}
