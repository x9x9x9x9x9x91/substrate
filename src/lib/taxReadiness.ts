// Pure model for the `dashboard: tax` readiness surface. Two vault
// sheets feed it and it writes to neither: an aggregates sheet whose csv
// carries the year's categories, and a missing-evidence snapshot an external
// exporter regenerates from wherever the books actually live. The books stay
// canonical — this pane only answers "how ready is the year to hand over", so
// every display decision is computable here and nothing in it can change the
// books.
//
// Nothing here knows a tax regime. The board's cards are the ordinary
// frontmatter `cards:` bindings every metrics surface uses (§5.2), so which
// totals a year is judged on — and what they are called — is the vault's
// decision, not this module's.

import { daysInMonth, isIsoDate } from "./dates.ts";
import { parseSheet } from "./sheet.ts";
import { headerIndex, readNoteTable } from "./notetable.ts";

export type SnapshotFreshnessKind = "fresh" | "stale" | "missing" | "invalid" | "future";

export interface SnapshotFreshness {
  kind: SnapshotFreshnessKind;
  exported: string | null;
  ageMs: number | null;
  stale: boolean;
}

const ISO_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):?(\d{2}))$/;

/** Missing, malformed and future stamps are all stale: none proves when this
 * derived artifact last agreed with its source. Exactly-at-threshold remains
 * fresh; "stale" begins once the configured maximum age has been exceeded.
 */
export function snapshotFreshness(
  exported: unknown,
  nowMs: number,
  staleHours = 36
): SnapshotFreshness {
  const stamp = typeof exported === "string" ? exported.trim() : "";
  if (stamp === "") return { kind: "missing", exported: null, ageMs: null, stale: true };
  const parts = ISO_STAMP_RE.exec(stamp);
  if (!parts)
    return { kind: "invalid", exported: stamp, ageMs: null, stale: true };
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw = "0", offsetHourRaw, offsetMinuteRaw] = parts;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = offsetHourRaw === undefined ? 0 : Number(offsetHourRaw);
  const offsetMinute = offsetMinuteRaw === undefined ? 0 : Number(offsetMinuteRaw);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    // the month check runs first, so the length lookup only ever sees 1-12
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return { kind: "invalid", exported: stamp, ageMs: null, stale: true };
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return { kind: "invalid", exported: stamp, ageMs: null, stale: true };
  if (at > nowMs) return { kind: "future", exported: stamp, ageMs: 0, stale: true };
  const ageMs = nowMs - at;
  const maxAgeMs = (Number.isFinite(staleHours) && staleHours > 0 ? staleHours : 36) * 3_600_000;
  return {
    kind: ageMs > maxAgeMs ? "stale" : "fresh",
    exported: stamp,
    ageMs,
    stale: ageMs > maxAgeMs,
  };
}

export interface TaxMissingItem {
  /** source sheet the row lives in — free text, the grouping key */
  sheet: string;
  name: string;
  /** ISO day, or "" when the row carries none (or an unparseable one) */
  date: string;
  /** the evidence fields still missing, in the exporter's order */
  missing: string[];
}

export interface TaxMissingGroup {
  sheet: string;
  items: TaxMissingItem[];
}

export interface TaxCategoryRow {
  category: string;
  /** source sheet the category totals came from — tooltip context only */
  sheet: string;
  /** documents behind the total; an unparseable count reads as 0 */
  rows: number;
  amountEur: number | null;
  basis: string;
}

export type TaxVerdict = "ready" | "missing" | "unavailable";

export interface TaxReadinessState {
  verdict: TaxVerdict;
  color: string;
  label: string;
}

const SEPARATOR = ";";

/** A count cell: whole non-negative numbers only, anything else reads as 0.
    The exporter owns these columns, so a malformed one is its bug to fix —
    but a dashboard that refuses to render because one cell is junk helps
    nobody. */
function countCell(raw: string): number {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return 0;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : 0;
}

/** A money cell: a plain signed decimal, else null (rendered as "—"). Blank,
    exponent notation and grouped text all read as absent rather than as a
    guessed number — a wrong euro figure on a tax board is worse than none. */
function moneyCell(raw: string): number | null {
  const t = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Rows of the missing-evidence snapshot that satisfy the whole contract.
    Headers match by name, case-insensitively and in any order. A row with no
    name or no missing-field list is skipped rather than raised — the same
    policy the food log takes with its hand-editable csv (`parseFoodRows`),
    for the same reason: the app never writes this sheet, so a malformed row
    is the exporter's to fix and must not blank the pane. An unparseable
    `date` degrades to empty (the row still shows, sorted last) — dropping a
    row would hide a document that is genuinely missing. */
export function parseTaxMissing(body: string): TaxMissingItem[] {
  const table = readNoteTable(body);
  if (!table) return [];
  const si = table.col("sheet");
  const ni = table.col("name");
  const di = table.col("date");
  const mi = table.col("missing");
  if (ni < 0 || mi < 0) return [];

  const out: TaxMissingItem[] = [];
  for (const cells of table.rows) {
    const name = table.text(cells, ni);
    const missing = table
      .raw(cells, mi)
      .split(SEPARATOR)
      .map((field) => field.trim())
      .filter((field) => field !== "");
    if (name === "" || missing.length === 0) continue;
    const rawDate = table.text(cells, di);
    out.push({
      sheet: table.text(cells, si),
      name,
      date: isIsoDate(rawDate) ? rawDate : "",
      missing,
    });
  }
  return out;
}

/** Sheet A–Z, then date ascending with undated rows last, then name. Fully
    ordered so a regenerated snapshot renders identically even when the
    exporter's row order changes. */
export function sortTaxMissing(items: readonly TaxMissingItem[]): TaxMissingItem[] {
  const collate = (a: string, b: string) =>
    a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b, "en");
  return [...items].sort(
    (a, b) =>
      collate(a.sheet, b.sheet) ||
      (a.date === "" ? 1 : 0) - (b.date === "" ? 1 : 0) ||
      a.date.localeCompare(b.date) ||
      collate(a.name, b.name) ||
      a.missing.join(SEPARATOR).localeCompare(b.missing.join(SEPARATOR))
  );
}

/** The checklist as the pane draws it: sorted rows, grouped by sheet, group
    order following the sorted rows (so sheet order is the same A–Z). */
export function groupTaxMissing(items: readonly TaxMissingItem[]): TaxMissingGroup[] {
  const groups: TaxMissingGroup[] = [];
  for (const item of sortTaxMissing(items)) {
    const last = groups[groups.length - 1];
    if (last && last.sheet === item.sheet) last.items.push(item);
    else groups.push({ sheet: item.sheet, items: [item] });
  }
  return groups;
}

/** The aggregates sheet's csv as the board's category table. Only the csv is
    read here: the cards are frontmatter bindings resolved through the shared
    card reader, so a sheet that defines no summaries at all still gets its
    table, and a card naming a summary that isn't there says so on the card. */
export function taxCategories(body: string): TaxCategoryRow[] {
  const model = parseSheet(body);
  const ci = headerIndex(model.headers, "category");
  const si = headerIndex(model.headers, "sheet");
  const ri = headerIndex(model.headers, "rows");
  const ai = headerIndex(model.headers, "amount_eur");
  const bi = headerIndex(model.headers, "basis");
  const categories: TaxCategoryRow[] = [];
  if (ci < 0) return categories;
  for (const row of model.rows) {
    const category = (row[ci] ?? "").trim();
    // A zero-row zero-amount category is information (nothing booked in that
    // category yet) and stays; only a nameless row is dropped.
    if (category === "") continue;
    categories.push({
      category,
      sheet: si >= 0 ? (row[si] ?? "").trim() : "",
      rows: ri >= 0 ? countCell(row[ri] ?? "") : 0,
      amountEur: ai >= 0 ? moneyCell(row[ai] ?? "") : null,
      basis: bi >= 0 ? (row[bi] ?? "").trim() : "",
    });
  }
  return categories;
}

/** Freshness in words, for the head's state and the alert line. */
export function taxFreshnessLabel(fresh: SnapshotFreshness): string {
  if (fresh.kind === "missing") return "export stamp missing";
  if (fresh.kind === "invalid") return "export stamp invalid";
  if (fresh.kind === "future") return "export stamp is in the future";
  const minutes = Math.max(0, Math.floor((fresh.ageMs ?? 0) / 60_000));
  if (minutes < 60) return `snapshot ${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `snapshot ${hours}h old`;
  return `snapshot ${Math.floor(hours / 24)}d old`;
}

/** The readiness verdict behind the head's dot.

    Red is reserved for "this board cannot be trusted": the snapshot is
    unreadable (`fresh === null` — read failure or a source that isn't a
    sheet) or its export stamp is stale, missing, invalid or in the future.
    Outstanding documents are amber, not red — that is ordinary work in
    progress, and a year with missing paperwork still has a readable board.
    A failing AGGREGATES sheet never reddens the dot; its cards go missing
    on their own. */
export function taxReadinessState(
  missingCount: number,
  fresh: SnapshotFreshness | null
): TaxReadinessState {
  if (fresh === null)
    return { verdict: "unavailable", color: "var(--danger)", label: "snapshot unavailable" };
  if (fresh.stale)
    return { verdict: "unavailable", color: "var(--danger)", label: taxFreshnessLabel(fresh) };
  if (missingCount > 0)
    return {
      verdict: "missing",
      color: "var(--opt-yellow)",
      label: `${missingCount} ${missingCount === 1 ? "document" : "documents"} missing`,
    };
  return { verdict: "ready", color: "var(--ok)", label: "ready — nothing missing" };
}
