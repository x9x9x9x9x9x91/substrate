/* Deep Recall's labels: the sentences that turn a row of the past into an
   answer to "where and when did this text live?".

   Out of the components on purpose — the lifespan clause is the whole claim
   of a recall result ("lived in Masters/veilwork.md March–June 2026, deleted in
   77c0de1"), and a claim that specific deserves a test rather than a render. */

import type { RecallGroup } from "./types";

/** "4 Mar 2026" — a past version is a moment, so it is named by its day
    rather than by "3 days ago": the whole point of the row is WHEN. */
export function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Where and when this text lived, in one clause — "March 2026 – June 2026 ·
    deleted in 77c0de1". Months, not days: the span is the fact, and the exact
    day of each version is already on the version rows underneath. */
export function lifespan(g: RecallGroup): string {
  const month = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const from = month(g.first_ts_ms);
  const to = month(g.last_ts_ms);
  const when = from === to ? from : `${from} – ${to}`;
  // "deleted" is the group's own fact, but the commit that did it belongs to
  // the newest version — an older one was replaced, not removed
  const end = g.deleted
    ? `deleted in ${g.versions[0]?.last_id.slice(0, 7) ?? "a later snapshot"}`
    : "rewritten since";
  return `${when} · ${end}`;
}

/** The tail of a collapsed group: how many versions are NOT on screen. Empty
    when none are hidden — a "0 older versions collapsed" line would be noise
    claiming to be honesty. */
export function collapsedLabel(g: RecallGroup): string {
  const hidden = g.total_versions - g.versions.length;
  if (hidden <= 0) return "";
  return `${hidden} older ${hidden === 1 ? "version" : "versions"} collapsed`;
}

/** "1.4 MB" — the index is the size of a big photo or of nothing at all, and
    both readings should be legible at a glance. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
