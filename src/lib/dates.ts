/** Date-prop helpers. Values stay ISO (`2026-07-17`) in YAML so files remain
    portable; only the display is human. All math is done on plain y/m/d
    components — no Date-object timezone pitfalls. */

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function isIsoDate(v: string): boolean {
  if (!ISO_DATE_RE.test(v)) return false;
  const [, m, d] = v.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(Number(v.slice(0, 4)), m);
}

/** "2026-07-17" → "Jul 17, 2026"; non-ISO values pass through untouched. */
export function formatDateHuman(v: string): string {
  if (!isIsoDate(v)) return v;
  const [y, m, d] = v.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function todayIso(): string {
  const t = new Date();
  return toIso(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/** Milliseconds from `now` to the next local midnight (plus 1ms so the
 * timeout lands strictly inside the new day). The Date constructor
 * normalizes the +1 day, so month/year boundaries and DST stay correct.
 * Drives the day-rollover timer in useTodayIso (SUB-153). */
export function msUntilNextMidnight(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(0, midnight.getTime() - now.getTime()) + 1;
}

/** Shift a YYYY-MM-DD date by whole days, staying on the local calendar. */
export function shiftDate(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(y, mo - 1, d + days);
  return toIso(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/** The local ISO day `days` before `now` (default: the current moment).
    Component arithmetic keeps it on the local calendar, so near local
    midnight it agrees with todayIso()/DateMenu where a UTC slice
    (`toISOString().slice(0, 10)`) would land a day off (SUB-718). */
export function daysAgoIso(days: number, now: Date = new Date()): string {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return toIso(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/** Whole days from one ISO day to another (`to` − `from`; negative when `to`
    is earlier). The y/m/d components are computed as UTC milliseconds, so the
    count is pure calendar arithmetic — local DST transitions can't drift it. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

const DURATION_RE = /^(\d+)([dw])$/;

/** A relative duration operand (`7d`, `2w`) resolved against `from`: days and
    weeks, landing on the ISO day the duration reaches (`7d` from 2026-07-17 →
    2026-07-24). Null when the text isn't a duration. Used by the query
    language's date comparisons (SUB-66), where durations measure from today. */
export function durationFrom(text: string, from: string): string | null {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  return shiftDate(from, Number(m[1]) * (m[2] === "w" ? 7 : 1));
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

const DOTTED_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const ISO_SHAPED_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/;
const MONTH_DAY_RE = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i;
const DAY_MONTH_RE = /^(\d{1,2})\s+([a-z]+)(?:,?\s+(\d{4}))?$/i;

const LONG_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Month number (1–12) for a 3+-letter prefix of a full month name ("jul",
    "july", "sept"), case-insensitive; null when no month starts with it. */
function monthFromName(name: string): number | null {
  const n = name.toLowerCase();
  if (n.length < 3) return null;
  const i = LONG_MONTHS.findIndex((m) => m.startsWith(n));
  return i === -1 ? null : i + 1;
}

/** Loose text → ISO: accepts ISO itself, dotted day-first dates
    ("7.8.2026" → 2026-08-07), month-name + day forms ("jul 17", "17 jul",
    optional year), else anything Date.parse takes. ISO-shaped input keeps
    its written calendar date — the date component is validated and taken
    as-is, never routed through Date.parse, which would roll invalid days
    into the next month and shift `Z` datetimes across midnight in
    negative-offset timezones. Month-name forms are resolved by hand because
    Date.parse reads a trailing day number as a 2-digit year ("jul 17" →
    2001-07-17, SUB-228); with no year written they mean the CURRENT year.
    Returns null when unparseable — including a Date.parse result on the
    engine's default year (≤ 2001) from yearless input, a silently-wrong
    answer. */
export function parseDateLoose(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (isIsoDate(t)) return t;
  const dotted = DOTTED_DATE_RE.exec(t);
  if (dotted) {
    const [, d, m, y] = dotted.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return toIso(y, m, d);
  }
  const shaped = ISO_SHAPED_RE.exec(t);
  if (shaped) {
    const [, y, m, d] = shaped.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return toIso(y, m, d);
  }
  const md = MONTH_DAY_RE.exec(t);
  const dm = md ? null : DAY_MONTH_RE.exec(t);
  const named = md ?? dm;
  if (named) {
    const m = monthFromName(md ? named[1] : named[2]);
    if (m !== null) {
      const day = Number(md ? named[2] : named[1]);
      const y = named[3] ? Number(named[3]) : new Date().getFullYear();
      if (day < 1 || day > daysInMonth(y, m)) return null;
      return toIso(y, m, day);
    }
    // a month-shaped word that names no month ("foo 17") falls through
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  // engine year-guesses on yearless input are silently wrong — V8 defaults a
  // missing year to 2001 ("2/3" → 2001-02-03), JSC to 19xx — so a pre-2002
  // result without a written 4-digit year is null, never committed (SUB-228)
  if (d.getFullYear() <= 2001 && !/\d{4}/.test(t)) return null;
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/* The hour may be single-digit ("9:30", SUB-714); minutes stay two-digit,
   matching splitDayTime's value grammar. */
const TRAILING_TIME_RE = /^(.*?)[T ](\d{1,2}):(\d{2})$/;

/** parseDateLoose plus an optional trailing ` HH:MM` time (SUB-270 — 24h,
    space or T separator): "2026-07-19 14:30" → { day: "2026-07-19", time:
    "14:30" }. A single-digit hour is accepted and normalized to the padded
    HH:MM the value grammar stores (SUB-714 — it used to fall through to the
    day-only path and silently lose the time). The day part is whatever
    parseDateLoose accepts; an out-of-range time (25:00) nulls the whole
    thing rather than silently dropping the time. parseDateLoose's own
    return shape is unchanged. */
export function parseDateTimeLoose(text: string): { day: string; time: string | null } | null {
  const t = text.trim();
  if (!t) return null;
  const timed = TRAILING_TIME_RE.exec(t);
  if (timed) {
    const hh = Number(timed[2]);
    const mm = Number(timed[3]);
    if (hh > 23 || mm > 59) return null;
    const day = parseDateLoose(timed[1]);
    return day ? { day, time: `${String(hh).padStart(2, "0")}:${timed[3]}` } : null;
  }
  const day = parseDateLoose(t);
  return day ? { day, time: null } : null;
}

export interface MonthCell {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** 6×7 Monday-first grid for one month, padded with neighbor-month days. */
export function monthGrid(y: number, m: number): MonthCell[] {
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
  const cells: MonthCell[] = [];
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevDays = daysInMonth(prevY, prevM);
  for (let i = lead - 1; i >= 0; i--)
    cells.push({ iso: toIso(prevY, prevM, prevDays - i), day: prevDays - i, inMonth: false });
  for (let d = 1; d <= daysInMonth(y, m); d++)
    cells.push({ iso: toIso(y, m, d), day: d, inMonth: true });
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  for (let d = 1; cells.length < 42; d++)
    cells.push({ iso: toIso(nextY, nextM, d), day: d, inMonth: false });
  return cells;
}

export function monthLabel(y: number, m: number): string {
  const LONG = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${LONG[m - 1]} ${y}`;
}
