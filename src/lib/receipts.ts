/** Receipts — the render half of per-fact provenance (receipts spec §4.4, §6).
    The backend hands each change point a semantic `Actor`; everything a person
    actually reads is decided here, so the enum never carries display text and
    the wording lives in one place for the peek, the chip footer, and their
    tests. */

import type { Actor, FactLane, FactPoint } from "./types.ts";
import { dateLocale } from "./dateLocale.ts";

/** Commit subjects Substrate itself writes (lib.rs, commands/notes.rs,
    commands/history.rs, mcpdoor/server.rs). A commit carrying one of these was
    made by this app on the reader's own behalf, so it reads as "You"; an `app` point with
    any other subject is pre-convention history, where an app edit and an
    outside edit are indistinguishable (§4.4's stated cost) and the honest
    wording is the vaguer "In the app". */
const APP_SUBJECTS = [
  "snapshot",
  "seal ",
  "restore ",
  "external edit to ",
  "before vault time travel",
];

const isAppSubject = (subject: string) =>
  APP_SUBJECTS.some((s) => (s.endsWith(" ") ? subject.startsWith(s) : subject === s || subject.startsWith(`${s} `)));

/** How one change point names its author, in the app's personal wording
    (spec §4.4): "You" for this app, the client name for
    an MCP write, "sync" for a merge, "external edit" for a self-declared
    outside write, "external tool (<author>)" for a foreign git identity — and
    "In the app" for history written before Substrate had any conventions. */
export function actorText(actor: Actor, subject = ""): string {
  switch (actor.kind) {
    case "app":
      return isAppSubject(subject) ? "You" : "In the app";
    case "mcp":
      return actor.name ? `${actor.name} (via MCP)` : "via MCP";
    case "sync":
      return "sync";
    case "bulk":
      return "You";
    case "external":
      return "external edit";
    case "external_tool":
      return `external tool (${actor.name})`;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age of a change point — "just now", "12m ago", "5h ago", "3d ago",
    and a plain date once a change is old enough that counting days stops
    meaning anything. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Intl.DateTimeFormat(dateLocale(), { year: "numeric", month: "short", day: "numeric" }).format(ms);
}

/** The date the footer states as a boundary — a day, not a moment: the footer
    answers "how far back does this go", which is a coarser question than a
    row's. */
export function boundaryDate(ms: number): string {
  return new Intl.DateTimeFormat(dateLocale(), { year: "numeric", month: "short", day: "numeric" }).format(ms);
}

/** The peek's rows: change points newest first. The lane is complete by
    construction, so this is the whole truth the peek scrolls through. */
export function receiptRows(lane: FactLane | undefined): FactPoint[] {
  return lane ? [...lane.points].reverse() : [];
}

/** The peek's footer, which is never blank (§6, the trim trap): either the
    lane reaches its own beginning — "first set <date>" — or history was
    trimmed under it and the honest line says so. A lane with no points at all
    (a fact the vault's history never saw change) still gets a line. */
export function footerText(lane: FactLane | undefined): string {
  const points = lane?.points ?? [];
  const oldest = lane?.oldest_ts_ms ?? null;
  if (points.length === 0) {
    return oldest === null ? "no snapshots yet" : `no history before ${boundaryDate(oldest)}`;
  }
  const first = points[0];
  // the lane starts where history itself does: anything before the oldest
  // surviving snapshot was trimmed, so "first set" would be a guess
  if (oldest !== null && first.ts_ms <= oldest) return `no history before ${boundaryDate(oldest)}`;
  return `first set ${boundaryDate(first.ts_ms)}`;
}

/** The chip editor's quiet last-change line — the keyboard path to the same
    peek (§6). Undefined while the lane hasn't landed, so the footer can hold
    its own placeholder rather than claim a change that may not exist. */
export function lastChangeText(lane: FactLane | undefined, now?: number): string | undefined {
  const rows = receiptRows(lane);
  const last = rows[0];
  if (!last) return undefined;
  return `Last changed ${relativeTime(last.ts_ms, now)} · ${actorText(last.actor, last.subject)}`;
}
