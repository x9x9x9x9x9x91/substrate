/**
 * A sheet's per-column notification settings (SUB-876).
 *
 * A sheet has no schema — `type: sheet` is functional, so there is nowhere to
 * hang a per-property `notify` the way a database does. The settings live in
 * the note's own frontmatter instead, under `columns:`, keyed by header name:
 *
 * ```yaml
 * columns:
 *   Renewal: { notify: true, notifyBefore: 7 }
 * ```
 *
 * The two words are the ones databases already use (docs/vault-format.md §6),
 * and the name binds case-insensitively on both sides — a header typed
 * `Renewal` answers to a `renewal:` key here and in the scheduler's
 * `notifying_columns`. Keep the folding rules in step: a column the UI thinks
 * is quiet but the backend fires on is the failure this file exists to avoid.
 */

import { splitDateRange } from "./calendar.ts";

export interface ColumnNotify {
  /** fire on the day the cell's date lands */
  notify?: boolean;
  /** also fire this many days ahead (1..365, clamped by the backend) */
  notifyBefore?: number;
}

/** The lead times the column menu offers. Any 1..365 value round-trips, so a
    hand-edited `notifyBefore: 21` keeps working; these are the ones worth a
    click. */
export const LEAD_CHOICES = [1, 3, 7, 14, 30];

/** A cell reads as a date when it parses as a whole date value — the same
    grammar the scheduler applies, since `splitDateRange` is the declared TS
    mirror of `notify::parse_due_range`. Prefix-matching an ISO day instead
    would offer "Notify…" on a cell the scheduler refuses (seconds, SUB-571)
    and hide the menu on a range it accepts (SUB-876 review). */
export function looksDated(cell: string): boolean {
  return splitDateRange(cell) !== null;
}

/** Case-insensitive lookup into the `columns:` map, matching the backend's
    fold. An exact hit wins, so a sheet carrying both `Due` and `due` behaves
    the way its header reads rather than by map order. */
export function columnNotifyOf(
  columns: Record<string, ColumnNotify> | undefined,
  name: string
): ColumnNotify | undefined {
  if (!columns) return undefined;
  const exact = columns[name];
  if (exact) return exact;
  const folded = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(columns)) {
    if (k.trim().toLowerCase() === folded) return v;
  }
  return undefined;
}

/** How a column's setting reads in the menu — "" when it never fires. */
export function notifyHint(s: ColumnNotify | undefined): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.notify) parts.push("on the day");
  if (s.notifyBefore) parts.push(`${s.notifyBefore}d before`);
  return parts.join(" · ");
}

/** Read the `columns:` map off a note's props. Hand-edited frontmatter can put
    anything there, so entries that don't parse are dropped rather than trusted
    — one bad line must not hide the rest. The on-disk spelling is `notifyBefore`
    and only that: it is what `notifying_columns` folds for on the Rust side and
    what both docs document, so accepting a `notify_before` alias here would
    render a confirmed setting the scheduler never fires (SUB-876 review). */
export function parseColumnNotify(raw: unknown): Record<string, ColumnNotify> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ColumnNotify> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const before = e.notifyBefore;
    out[name] = {
      notify: e.notify === true,
      notifyBefore: typeof before === "number" && before > 0 ? before : undefined,
    };
  }
  return out;
}

/** Find the row a notification named. Identity is the first cell, folded —
    the same rule the scheduler keyed the alert with, so a row that was moved
    or sorted still resolves and a renamed one quietly doesn't. */
export function findRevealCell(
  headers: string[],
  rows: string[][],
  target: { column: string; row: string }
): { r: number; c: number } | null {
  const col = target.column.trim().toLowerCase();
  const c = headers.findIndex((h) => h.trim().toLowerCase() === col);
  if (c === -1) return null;
  const label = target.row.trim().toLowerCase();
  const r = rows.findIndex((row) => (row[0] ?? "").trim().toLowerCase() === label);
  return r === -1 ? null : { r, c };
}
