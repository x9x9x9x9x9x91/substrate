// The reader half of time-travel queries (docs/time-travel-spec.md):
// fact lanes from the backend, plus the notes the app already has loaded, turned
// into the *synchronous* resolver the formula engine reads through (§3.1).
// Pure TS, no DOM/node imports: runs in the app and under `node --test`.

import type { HistoryLookup, HistoryResolver } from "./formula.ts";
import { isIsoDate, toIso } from "./dates.ts";
import type { FactLane, HistorySheetsAt, NoteMeta } from "./types.ts";

/** The last instant of local day `D` — the moment `AT(D, …)` reads at
    (docs/time-travel-spec.md §2.1). Built the way the app builds every other
    day boundary (`msUntilNextMidnight`, dates.ts): midnight *after* D in the
    reader's own timezone, minus a millisecond. Snapshot times are UTC epochs,
    so a vault written in Berlin and read in Tokyo answers by the reader's
    calendar — which is the calendar the date in the formula was typed in.
    Null when the string isn't an ISO day. */
export function endOfLocalDay(iso: string): number | null {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime() - 1;
}

/** The ISO day a snapshot timestamp falls on, in the reader's timezone. */
export function isoDayOf(tsMs: number): string {
  const t = new Date(tsMs);
  return toIso(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/** The vault's sheet notes as they stood on one past day — what
    `AT(date, Sheet.member)` re-evaluates (§3.2). `commit` null means no
    snapshot exists at or before that day; `oldest` is the trim boundary's ISO
    day (null when the vault has no snapshots at all), so a date below it says
    "no history before …" rather than reading as an empty vault. */
export interface HistorySheetSnapshot {
  date: string;
  commit: string | null;
  oldest: string | null;
  notes: { path: string; title: string; stem: string; body: string }[];
}

/** Pairs the backend's instant-keyed answers back onto the days that asked for
    them. The request converts day → instant here too (`endOfLocalDay`), so the
    reader's calendar defines the boundary in exactly one place; a day the
    backend did not answer is simply absent, and reads as "not loaded yet". */
export function historySheetSnapshots(
  dates: readonly string[],
  ats: readonly HistorySheetsAt[]
): HistorySheetSnapshot[] {
  const byInstant = new Map(ats.map((a) => [a.instant_ms, a]));
  const out: HistorySheetSnapshot[] = [];
  for (const date of dates) {
    const instant = endOfLocalDay(date);
    if (instant === null) continue;
    const at = byInstant.get(instant);
    if (!at) continue;
    out.push({
      date,
      commit: at.commit,
      oldest: at.oldest_ts_ms === null ? null : isoDayOf(at.oldest_ts_ms),
      notes: at.sheets,
    });
  }
  return out;
}

const factKey = (path: string, key: string) => `${path}\u0000${key}`;

/** The value a lane held at `instantMs`: the newest point at or before it.
    Mirrors `factlane::value_at` (src-tauri/src/factlane.rs) — the same three
    answers, so the phone, the desktop and the chart agree. A date before the
    oldest surviving snapshot is *unknowable*, never answered from the oldest
    surviving value: that is the trim trap (§2.3). */
export function valueAt(lane: FactLane, instantMs: number): HistoryLookup {
  if (lane.oldest_ts_ms === null) return { kind: "unknowable", oldest: null };
  if (instantMs < lane.oldest_ts_ms) {
    return { kind: "unknowable", oldest: isoDayOf(lane.oldest_ts_ms) };
  }
  // points are oldest-first and carry one entry per *change*, so this is a
  // binary search for the last change at or before the instant
  let lo = 0;
  let hi = lane.points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lane.points[mid].ts_ms <= instantMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return { kind: "absent" }; // covered by history, but not written yet
  const v = lane.points[lo - 1].value;
  return v === null ? { kind: "absent" } : { kind: "value", value: v };
}

/** One live frontmatter value, rendered the way a lane renders a historical one
    (`factlane::fact_value`) so `PROP(n, k)` and `AT(TODAY(), PROP(n, k))` cannot
    disagree about the same value. Absent and empty are the same answer: blank. */
export function presentValue(props: Record<string, unknown>, key: string): HistoryLookup {
  if (!Object.prototype.hasOwnProperty.call(props, key)) return { kind: "absent" };
  const v = props[key];
  if (v === null || v === undefined) return { kind: "absent" };
  const text = Array.isArray(v) ? v.map((x) => String(x)).join(", ") : String(v);
  return text.trim() === "" ? { kind: "absent" } : { kind: "value", value: text };
}

/** The resolver `evaluate` reads facts through. `notes` is the vault as it is
    *today* — the path check runs against it in both tenses, so a mistyped path
    is an error rather than a silent "did not exist yet" (§2.3) — and `lanes` is
    whatever the as-of prefetch returned. A fact with no lane answers `pending`
    rather than blank: not knowing yet and knowing there was nothing are
    different facts, and only one of them is safe to render as empty. */
export function makeHistoryResolver(
  notes: readonly Pick<NoteMeta, "path" | "props">[],
  lanes: readonly FactLane[] = []
): HistoryResolver {
  const byPath = new Map(notes.map((n) => [n.path, n.props]));
  const byFact = new Map(lanes.map((l) => [factKey(l.path, l.key), l]));
  return (path, key, date) => {
    const props = byPath.get(path);
    if (props === undefined) return { kind: "unknown-note" };
    if (date === null) return presentValue(props, key);
    const instant = endOfLocalDay(date);
    if (instant === null) return { kind: "pending" };
    const lane = byFact.get(factKey(path, key));
    return lane ? valueAt(lane, instant) : { kind: "pending" };
  };
}
