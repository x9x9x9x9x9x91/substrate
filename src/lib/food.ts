// Food log data for the `dashboard: food` renderer: one pure pass
// over the log sheet's csv fence shaping everything the pane shows — the focus
// day's net kcal against the 1900–2300 band (today unless the pane
// navigated), the 7- and 30-day averages, the 14-day day strip, and the
// repeat chips.
// The pane stays a dumb renderer; this module is the unit-tested half (the
// today.ts split).
//
// Net-kcal convention: a negative kcal row is exercise, so a day's total is
// already net. The band is a floor-not-target: under the floor is "still
// eating", not a win.
// Pure TS, erasable syntax only — runs in the app and under `node --test`.

import { replaceCsvRows } from "./sheet.ts";
import { headerIndex, readNoteTable } from "./notetable.ts";
import { normalizeNumberInput, parseStrictNumber } from "./aggregate.ts";
import { shiftDate } from "./dates.ts";

export interface FoodRow {
  /** local day, YYYY-MM-DD */
  date: string;
  food: string;
  kcal: number;
  /** null when the cell is empty or the column is missing */
  protein: number | null;
  /** data-row index in the csv fence (header excluded) — the delete handle */
  idx: number;
}

export type DayState = "empty" | "under" | "in" | "over";

export interface FoodDay {
  /** local day, YYYY-MM-DD */
  day: string;
  /** "Mon 20" */
  label: string;
  /** net kcal, 0 when nothing logged */
  total: number;
  /** rows logged that day */
  n: number;
  state: DayState;
}

export interface FoodData {
  rows: FoodRow[];
  /** the focus day, YYYY-MM-DD — `today` unless the pane navigated */
  focusDay: string;
  /** focus day's rows, log order (field names predate day navigation:
      today* describes the FOCUS day, not necessarily the real today) */
  today: FoodRow[];
  todayKcal: number;
  todayProtein: number;
  todayState: DayState;
  /** kcal until the ceiling; negative = over */
  headroom: number;
  /** kcal until the goal floor; negative = past it */
  toGoal: number;
  /** kcal burned on the focus day — |sum of negative rows|, 0 when none */
  todayBurn: number;
  /** Σ net − daysLogged7 × floor over the 7-day window (logged days only);
      null when nothing is logged — same "unlogged = forgot" stance as avg7 */
  weekDelta: number | null;
  /** mean of daily net totals over logged days in [today-6, today] */
  avg7: number | null;
  /** how many of the last 7 days have at least one row */
  daysLogged7: number;
  avg7State: DayState;
  /** mean of daily net totals over logged days in [today-29, today] */
  avg30: number | null;
  /** how many of the last 30 days have at least one row */
  daysLogged30: number;
  avg30State: DayState;
  /** [today-13, today] ascending — the day strip */
  days: FoodDay[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 20" — the day strip's label, parsed the local way dates.ts does. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  return isNaN(t.getTime()) ? iso : `${WEEKDAYS[t.getDay()]} ${t.getDate()}`;
}

/** Band verdict for a net total. Zero-row days classify as "empty" upstream —
    a logged total of exactly 0 (food fully offset by exercise) reads "under". */
export function bandState(total: number, floor: number, ceiling: number): DayState {
  if (total > ceiling) return "over";
  if (total >= floor) return "in";
  return "under";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Upper sanity bound on a single entry's kcal. Generous for any
    real meal or workout, so it only ever catches a digit-slip or a runaway
    expression — one absurd row would otherwise pin the strip's scale and
    poison the 7- and 14-day metrics for two weeks. */
export const KCAL_MAX = 20000;

/** Whether a kcal number is loggable: finite and inside the sanity bound,
    sign-agnostic so an exercise burn is judged by magnitude. */
export function kcalInRange(n: number): boolean {
  return isFinite(n) && Math.abs(n) <= KCAL_MAX;
}

/** All well-formed rows of the log sheet's csv fence, log order. Rows with a
    malformed date or non-numeric kcal are skipped, not errors — the sheet
    stays hand-editable. Columns match by name in any order, and `protein_g`
    is optional (early rows won't have it). */
export function parseFoodRows(body: string): FoodRow[] {
  const table = readNoteTable(body);
  if (!table) return [];
  const di = table.col("date");
  const fi = table.col("food");
  const ki = table.col("kcal");
  const pi = table.col("protein_g");
  if (di < 0 || ki < 0) return [];
  const out: FoodRow[] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const cells = table.rows[r];
    const date = table.text(cells, di);
    // strict parse like sheet cells: "1e3"/"0x10"/"Infinity" are
    // skipped text, never 1000 kcal
    // Hand edits type the app's own de-DE display dialect ("1.234"), which
    // the strict parser alone reads as text — fold it first.
    const kcal = parseStrictNumber(normalizeNumberInput(table.raw(cells, ki)));
    if (!DAY_RE.test(date) || kcal === null) continue;
    const protein = pi >= 0 ? parseStrictNumber(normalizeNumberInput(table.raw(cells, pi))) : null;
    out.push({ date, food: table.text(cells, fi), kcal, protein, idx: r });
  }
  return out;
}

export interface FoodEntry {
  date: string;
  food: string;
  kcal: number;
  protein: number | null;
}

const CSV_HEADER = ["date", "food", "kcal", "protein_g"];

/** Body with the entry appended to the csv fence (created, header included,
    when the note has none yet). The header's column order is the sheet
    owner's — reading is order-free, so writing must be too: cells map into
    the EXISTING header, and a missing protein_g column is added (with its
    value) rather than silently dropped. */
export function appendFoodEntry(body: string, e: FoodEntry): string {
  const table = readNoteTable(body);
  const parsed = table ? table.allRows() : [];
  // blank lines parse as [""] rows; drop them so a whitespace-only fence
  // reads as empty and a hand-added leading blank line doesn't get mistaken
  // for the header (which would orphan the real rows below it)
  const rows = parsed.filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) rows.push([...CSV_HEADER]);
  const headers = rows[0];
  if (e.protein !== null && headerIndex(headers, "protein_g") < 0) headers.push("protein_g");
  const cells = headers.map((h) => {
    switch (h.trim().toLowerCase()) {
      case "date":
        return e.date;
      case "food":
        return e.food;
      case "kcal":
        return String(e.kcal);
      case "protein_g":
        return e.protein === null ? "" : String(e.protein);
      default:
        return ""; // a column this pane doesn't know stays empty
    }
  });
  rows.push(cells);
  return replaceCsvRows(body, rows);
}

/** Body with data row `idx` (header excluded) removed; unchanged when the
    index is stale — the vault may have moved under the pane. */
export function removeFoodEntry(body: string, idx: number): string {
  const table = readNoteTable(body);
  if (!table) return body;
  if (idx < 0 || idx >= table.rows.length) return body;
  table.rows.splice(idx, 1);
  return replaceCsvRows(body, table.allRows());
}

/** Everything the food pane shows, from the log body + the dashboard note's
    band props. `focus` is the day the hero/rows describe (day
    navigation) — default today; avg7, avg30, weekDelta and the 14-day strip
    stay anchored to the real `today` either way. Read-only display data. */
export function foodData(
  body: string,
  today: string,
  floor: number,
  ceiling: number,
  focus = today
): FoodData {
  const rows = parseFoodRows(body);
  const byDay = new Map<string, FoodRow[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);

  const dayTotal = (day: string): number =>
    (byDay.get(day) ?? []).reduce((s, r) => s + r.kcal, 0);

  const focusRows = byDay.get(focus) ?? [];
  const focusKcal = dayTotal(focus);
  const focusProtein = focusRows.reduce((s, r) => s + Math.max(0, r.protein ?? 0), 0);
  const focusBurn = focusRows.reduce((s, r) => s + (r.kcal < 0 ? -r.kcal : 0), 0);

  // window averages over logged days only — an unlogged day is "forgot", and
  // averaging in zeros would flatter the number the cut steers on
  const windowStats = (len: number): { sum: number; logged: number } => {
    let sum = 0;
    let logged = 0;
    for (let i = 0; i < len; i++) {
      const day = shiftDate(today, -i);
      if ((byDay.get(day) ?? []).length === 0) continue;
      sum += dayTotal(day);
      logged++;
    }
    return { sum, logged };
  };
  const { sum: sum7, logged: daysLogged7 } = windowStats(7);
  const avg7 = daysLogged7 > 0 ? sum7 / daysLogged7 : null;
  const { sum: sum30, logged: daysLogged30 } = windowStats(30);
  const avg30 = daysLogged30 > 0 ? sum30 / daysLogged30 : null;

  const days: FoodDay[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = shiftDate(today, -i);
    const n = (byDay.get(day) ?? []).length;
    const total = n > 0 ? dayTotal(day) : 0;
    days.push({
      day,
      label: dayLabel(day),
      total,
      n,
      state: n === 0 ? "empty" : bandState(total, floor, ceiling),
    });
  }

  return {
    rows,
    focusDay: focus,
    today: focusRows,
    todayKcal: focusKcal,
    todayProtein: focusProtein,
    todayState: focusRows.length === 0 ? "empty" : bandState(focusKcal, floor, ceiling),
    headroom: ceiling - focusKcal,
    toGoal: floor - focusKcal,
    todayBurn: focusBurn,
    // week vs goal measures the same days avg7 does, so the two metrics
    // never disagree about which days count
    weekDelta: daysLogged7 > 0 ? sum7 - daysLogged7 * floor : null,
    avg7,
    daysLogged7,
    avg7State: avg7 === null ? "empty" : bandState(avg7, floor, ceiling),
    avg30,
    daysLogged30,
    avg30State: avg30 === null ? "empty" : bandState(avg30, floor, ceiling),
    days,
  };
}
