// Curated newsfeed data for the `dashboard: feed` renderer (SUB-518): one pure
// pass over the items sheet's csv fence shaping the unified stream the pane
// renders, plus the fb (feedback) write-back transformer.
//
// The curator (an external agent) owns every column except `fb`; the app is the
// only writer of `fb`. So the write path touches exactly one cell and leaves the
// rest of the body byte-identical — that's `setSheetCell`'s contract, reused
// here rather than re-serialized.
//
// Stream order is date DESC, then the sheet's own row order within a date: that
// intra-day order IS the curator's ranking, so it must never be re-sorted.
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { findFence, parseCsv, setSheetCell } from "./sheet.ts";
import { fmtDur } from "./syncstory.ts";

/** "" = no verdict yet; the app cycles through these three. */
export type Feedback = "" | "up" | "down";

export interface FeedItem {
  /** local day, YYYY-MM-DD */
  date: string;
  /** freeform slug — any value renders; unknown ones get a neutral chip */
  topic: string;
  title: string;
  source: string;
  /** raw url as written; may be empty or non-http */
  url: string;
  /** what it is */
  blurb: string;
  /** why it matters to you */
  why: string;
  fb: Feedback;
  /** data-row index in the csv fence (header excluded) — the write handle */
  idx: number;
}

// header lookup is name-based and case-insensitive so column order in the sheet
// stays free; everything but date+title is optional
function headerIdx(headers: string[], name: string): number {
  return headers.findIndex((h) => h.trim().toLowerCase() === name);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function asFeedback(raw: string): Feedback {
  const v = raw.trim().toLowerCase();
  return v === "up" || v === "down" ? v : "";
}

/** Only http(s) links are openable; anything else reads as absent so the pane
    renders nothing clickable (no file:// or javascript: from a synced note). */
export function isOpenableUrl(url: string): boolean {
  return /^https?:\/\/\S/i.test(url.trim());
}

/** Every well-formed row of the items sheet, in stream order: date DESC with
    the sheet's row order preserved inside each day. Rows with a malformed date
    or an empty title are skipped, not errors — the sheet stays hand-editable. */
export function parseFeedItems(body: string): FeedItem[] {
  const fence = findFence(body, "csv");
  if (!fence) return [];
  const rows = parseCsv(fence.inner);
  if (rows.length === 0) return [];
  const headers = rows[0];
  const di = headerIdx(headers, "date");
  const ti = headerIdx(headers, "title");
  if (di < 0 || ti < 0) return [];
  const topi = headerIdx(headers, "topic");
  const si = headerIdx(headers, "source");
  const ui = headerIdx(headers, "url");
  const bi = headerIdx(headers, "blurb");
  const wi = headerIdx(headers, "why");
  const fi = headerIdx(headers, "fb");
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
  const out: FeedItem[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const date = cell(cells, di);
    const title = cell(cells, ti);
    if (!DAY_RE.test(date) || title === "") continue;
    out.push({
      date,
      topic: cell(cells, topi),
      title,
      source: cell(cells, si),
      url: cell(cells, ui),
      blurb: cell(cells, bi),
      why: cell(cells, wi),
      fb: asFeedback(cell(cells, fi)),
      idx: r - 1,
    });
  }
  // stable sort: equal dates keep the curator's ranking
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Distinct topic slugs in stream order, lowercased (SUB-697). Items with an
    empty topic don't contribute a chip — they're only reachable with the
    filter off, which the pane's "all" state covers. */
export function feedTopics(items: FeedItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const t = it.topic.trim().toLowerCase();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The stream narrowed to `active` topics; an empty selection means no filter
    (everything shows). Selection entries that match no item are inert, so a
    persisted selection survives the topic set changing under it (SUB-697). */
export function filterFeedItems(items: FeedItem[], active: string[]): FeedItem[] {
  if (active.length === 0) return items;
  const want = new Set(active.map((t) => t.trim().toLowerCase()));
  return items.filter((it) => want.has(it.topic.trim().toLowerCase()));
}

export interface FeedDay {
  /** local day, YYYY-MM-DD */
  day: string;
  items: FeedItem[];
}

/** The stream split into date groups, newest day first. */
export function groupFeedByDay(items: FeedItem[]): FeedDay[] {
  const out: FeedDay[] = [];
  for (const it of items) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last !== null && last.day === it.date) last.items.push(it);
    else out.push({ day: it.date, items: [it] });
  }
  return out;
}

/** Cycle semantics: clicking the state that's already active clears it. */
export function cycleFeedback(current: Feedback, clicked: "up" | "down"): Feedback {
  return current === clicked ? "" : clicked;
}

/** The body with row `idx`'s fb cell set to the cycled verdict, everything else
    byte-identical. Returns the body unchanged when there's no csv fence, no fb
    column, or the row is out of range — a no-op write is better than a clobber.
    `expected` is the caller's guard for `vaultWriteBody` (SUB-93). */
export function setFeedback(
  body: string,
  idx: number,
  clicked: "up" | "down",
): { next: string; expected: string } {
  const fence = findFence(body, "csv");
  if (!fence) return { next: body, expected: body };
  const rows = parseCsv(fence.inner);
  if (rows.length === 0) return { next: body, expected: body };
  const fi = headerIdx(rows[0], "fb");
  if (fi < 0) return { next: body, expected: body };
  const row = rows[idx + 1];
  if (row === undefined) return { next: body, expected: body };
  const next = cycleFeedback(asFeedback(row[fi] ?? ""), clicked);
  return { next: setSheetCell(body, idx, fi, next), expected: body };
}

/* Staleness (SUB-699): the `curated:` stamp parsed as an instant, so a dead
   curator reads in the head as a warning dot with an age ("stale · 5d")
   instead of an innocent item count. Strictly additive — a missing or
   unparseable stamp classifies fresh and the pane keeps rendering it
   verbatim; the parse never gates rendering. */

/** ~36h uncurated means the morning-cadence curator AND its 26h self-heal
    watchdog (the jobs.rs freshness lane) both lost — the pipeline is down. */
export const FEED_STALE_MS = 36 * 3_600_000;

// RFC 3339 with Z or a numeric offset (Date.parse does the rest)
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
// "YYYY-MM-DD HH:MM[:SS]" (space or T), or the bare day — local time
const LOCAL_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The stamp as epoch-ms, mirroring the freshness probe's lenient parse
    (jobs.rs parse_stamp_ms): RFC 3339, "YYYY-MM-DD HH:MM[:SS]" local, or a
    bare "YYYY-MM-DD" at local midnight. Anything else → null. */
export function parseCuratedStamp(stamp: string | undefined): number | null {
  if (stamp === undefined) return null;
  const s = stamp.trim();
  if (s === "") return null;
  if (RFC3339_RE.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = LOCAL_STAMP_RE.exec(s);
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hh, mm, ss] = [
    m[4] === undefined ? 0 : Number(m[4]),
    m[5] === undefined ? 0 : Number(m[5]),
    m[6] === undefined ? 0 : Number(m[6]),
  ];
  const d = new Date(year, month - 1, day, hh, mm, ss);
  // new Date() rolls overflow forward (Feb 31, 25:00) — reject, don't guess
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d.getHours() !== hh ||
    d.getMinutes() !== mm ||
    d.getSeconds() !== ss
  )
    return null;
  return d.getTime();
}

export interface FeedStaleness {
  stale: boolean;
  /** the sync surface's compact age voice ("1d 16h", "5d"); "" unless stale */
  age: string;
}

/** Parse + classify in one pure step. Fresh when the stamp is absent,
    unparseable, in the future, or younger than FEED_STALE_MS. */
export function feedStaleness(curated: string | undefined, now = Date.now()): FeedStaleness {
  const t = parseCuratedStamp(curated);
  if (t === null) return { stale: false, age: "" };
  const age = now - t;
  if (age <= FEED_STALE_MS) return { stale: false, age: "" };
  return { stale: true, age: fmtDur(age) };
}
