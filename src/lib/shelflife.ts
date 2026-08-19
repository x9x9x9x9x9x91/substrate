// Shelf life — how old a fact is, and whether it is past the window its
// schema gave it. Pure TS, no DOM/node imports: runs in the app and under
// `node --test`. Keep to erasable TS syntax only (no enums/namespaces) so
// node can strip types.
//
// SOURCE OF TRUTH for what a review window MEANS. The engine
// (src-tauri/src/vault/schema.rs `canonical_review_window`) only decides what
// may be written to a schema; the arithmetic — how many days `6m` is, when a
// value goes past — lives here, so one file answers "is this stale?" for the
// freshness column and the stale-facts report alike. The vocabularies are
// mirrored (`review_windows_mirror_the_frontend` pins them); update both
// sides together.
//
// Nothing here notifies. A window is only ever an answer to a question a
// reader asked.

import type { FactFreshness } from "./types.ts";

/** Days per window unit. Months and years are NOMINAL — a shelf life is a
    rule of thumb ("check phone numbers about once a year"), not a calendar
    contract, and a fact that came due on the 29th of February would be a
    worse lie than one that came due a day early. */
export const REVIEW_UNIT_DAYS: Record<string, number> = {
  d: 1,
  w: 7,
  m: 30,
  y: 365,
};

/** Spoken windows and the compact form each stores as. */
export const REVIEW_WORDS: [string, string][] = [
  ["weekly", "1w"],
  ["monthly", "1m"],
  ["quarterly", "3m"],
  ["yearly", "1y"],
];

/** A window as it is stored, or null when the text names none. Mirrors the
    engine's `canonical_review_window`: spoken words fold to their compact
    form, a zero count is no window rather than an instantly-stale one, and a
    count is capped at three digits (a shelf life in centuries is a typo). */
export function canonicalReviewWindow(text: string | null | undefined): string | null {
  const w = (text ?? "").trim();
  for (const [word, compact] of REVIEW_WORDS) if (w.toLowerCase() === word) return compact;
  const m = /^(\d{1,3})([dwmy])$/i.exec(w);
  if (!m) return null;
  const count = Number(m[1]);
  if (!count) return null;
  return `${count}${m[2].toLowerCase()}`;
}

/** How many days a window lasts, or null when it names none. */
export function reviewWindowDays(text: string | null | undefined): number | null {
  const canon = canonicalReviewWindow(text);
  if (!canon) return null;
  const count = Number(canon.slice(0, -1));
  return count * REVIEW_UNIT_DAYS[canon.slice(-1)];
}

/** How a value stands against its window.

    `unknown` is its own answer rather than a flavour of stale: the value has
    no history a person left (an imported vault nobody has revisited, or a
    note older than the oldest snapshot), so how old it is cannot be said.
    Guessing there is exactly the invented history this surface exists to
    avoid. `unwindowed` is a value with a real age and no window — it can be
    shown, never overdue. */
export type ShelfState = "fresh" | "aging" | "due" | "unknown" | "unwindowed";

export interface ShelfReading {
  path: string;
  key: string;
  state: ShelfState;
  /** Whole days since a person last set the value; null when unknown. */
  ageDays: number | null;
  /** The window in days, null when the prop declares none. */
  windowDays: number | null;
  /** Days past the window — 0 until it is passed, null without one. */
  overdueDays: number | null;
  /** Age as a fraction of the window (1 = due today); null without one.
      This is what ranks the report: two months past a 90-day window reads
      as worse than two months past a yearly one, which is the honest order. */
  ratio: number | null;
  /** True when the fact HAS changed but only ever inside a sweep — carried
      through so a surface can say "an import touched this, nobody has" rather
      than showing the same blank as a fact with no history at all. */
  onlyBulk: boolean;
}

/** Age is rounded DOWN to whole days: a value set eight hours ago is "today",
    not "1 day". Nothing here rounds up, so nothing reads older than it is. */
const DAY_MS = 86_400_000;

/** Where the tint turns: a value is `aging` once it has used up this much of
    its window. Three quarters is late enough to be worth noticing and early
    enough to still be true. */
export const AGING_AT = 0.75;

/** Read one fact against its prop's window. `now` is passed in rather than
    read, so a test and a render both say what "now" means. */
export function shelfReading(
  fresh: FactFreshness,
  window: string | null | undefined,
  now: number
): ShelfReading {
  const windowDays = reviewWindowDays(window);
  const base = { path: fresh.path, key: fresh.key, windowDays, onlyBulk: fresh.only_bulk };
  if (fresh.reviewed_ts_ms === null) {
    return { ...base, state: "unknown", ageDays: null, overdueDays: null, ratio: null };
  }
  const ageDays = Math.max(0, Math.floor((now - fresh.reviewed_ts_ms) / DAY_MS));
  if (windowDays === null) {
    return { ...base, state: "unwindowed", ageDays, overdueDays: null, ratio: null };
  }
  const ratio = ageDays / windowDays;
  return {
    ...base,
    ageDays,
    overdueDays: Math.max(0, ageDays - windowDays),
    ratio,
    state: ratio >= 1 ? "due" : ratio >= AGING_AT ? "aging" : "fresh",
  };
}

/** The report's order: furthest past its window first, then the ones nearing
    it, then everything that cannot be dated. Ties break on the older value,
    and then on path and key so the same vault always ranks the same way. */
export function rankShelfReadings(readings: ShelfReading[]): ShelfReading[] {
  const rank = (r: ShelfReading) => (r.state === "due" ? 0 : r.state === "aging" ? 1 : 2);
  return [...readings].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if ((b.ratio ?? 0) !== (a.ratio ?? 0)) return (b.ratio ?? 0) - (a.ratio ?? 0);
    if ((b.ageDays ?? 0) !== (a.ageDays ?? 0)) return (b.ageDays ?? 0) - (a.ageDays ?? 0);
    return a.path.localeCompare(b.path) || a.key.localeCompare(b.key);
  });
}

/** The facts a report shows: past their window, or nearing it. A value with
    no window is not a finding — nobody said it goes off. */
export function pastWindow(readings: ShelfReading[]): ShelfReading[] {
  return rankShelfReadings(readings.filter((r) => r.state === "due" || r.state === "aging"));
}

/** The age as a reader would say it: "today", "3 days", "5 weeks", "2 years".
    Coarser the further back it goes, because a value set 400 days ago is
    "over a year", and the extra digits would suggest a precision the answer
    does not have. */
export function ageLabel(ageDays: number | null): string {
  if (ageDays === null) return "unknown";
  if (ageDays < 1) return "today";
  if (ageDays === 1) return "yesterday";
  if (ageDays < 14) return `${ageDays} days`;
  if (ageDays < 60) return `${Math.floor(ageDays / 7)} weeks`;
  if (ageDays < 730) return `${Math.floor(ageDays / 30)} months`;
  return `${Math.floor(ageDays / 365)} years`;
}

/** The window as a reader would say it: "yearly", "every 90 days". */
export function windowLabel(window: string | null | undefined): string | null {
  const canon = canonicalReviewWindow(window);
  if (!canon) return null;
  const spoken = REVIEW_WORDS.find(([, compact]) => compact === canon);
  if (spoken) return spoken[0];
  const count = Number(canon.slice(0, -1));
  const unit = { d: "day", w: "week", m: "month", y: "year" }[canon.slice(-1)] ?? "day";
  return `every ${count} ${unit}${count === 1 ? "" : "s"}`;
}
