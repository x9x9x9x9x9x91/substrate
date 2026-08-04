/** Progress fences — the goal thermometer (SUB-967). A ```progress fence puts
 *  one number against the number it is supposed to reach:
 *
 *    ```progress
 *    label: Signups
 *    value: count
 *    source: signup
 *    query: status:confirmed
 *    target: 10
 *    deadline: 2026-08-30
 *    start: 2026-08-02
 *    ```
 *
 *  or, bound to a sheet summary the way a metric card binds:
 *
 *    ```progress
 *    label: Savings
 *    value: {{Holdings.cash_total}}
 *    target: 50000
 *    format: eur
 *    ```
 *
 *  `value` is either a `{{Sheet.summary}}` bind or the literal `count`, which
 *  counts the rows a database `source:` (plus optional `query:`) matches —
 *  the same count a ```view fence's table reports, resolved through the same
 *  embed path. `target` takes a positive number or the same bind form, and
 *  `format`/`digits` are the metric card's, applied by the card's own
 *  formatter: one bind grammar and one number voice across every surface.
 *
 *  Pace (`deadline:`) is deliberately narrow. Nothing on disk records what a
 *  summary or a row count was yesterday, so "ahead/behind at the current
 *  rate" can only be honest when the fence says where the line starts:
 *
 *  - with `start:` — a straight line runs from 0 on the start day to `target`
 *    on the deadline, and the fence reports the distance from it. The start
 *    day is the day the value stood at zero; that is the one piece of history
 *    the vault can state, so the fence asks for it rather than inferring it.
 *  - without `start:` — no ahead/behind claim at all. The fence reports the
 *    days left and the rate still required, both of which follow from today's
 *    value alone.
 *
 *  Pure TS, no DOM/node imports: runs in the app and under `node --test`.
 *  Resolution and rendering live in src/components/ProgressDashboard.tsx. */

import { parseSource, type ChartSource } from "./chart.ts";
import { daysBetween, isIsoDate } from "./dates.ts";
import { embedQueryFor } from "./embeds.ts";
import { bindSheets, CARD_FORMATS, fmtCard, parseBind, unquote } from "./metriccards.ts";
import type { NoteMeta, SchemaConfig } from "./types.ts";

/** Either side of the thermometer: a sheet summary, or a row count. */
export type ProgressValue =
  | { kind: "bind"; bind: string }
  | { kind: "count"; source: ChartSource & { kind: "db" }; query: string | null };

export interface ProgressConfig {
  /** Optional display label; otherwise derived from the value binding. */
  label: string | null;
  value: ProgressValue;
  target: { kind: "number"; n: number } | { kind: "bind"; bind: string };
  /** ISO day the goal is due; drives the pace line */
  deadline: string | null;
  /** ISO day the value stood at zero — the anchor ahead/behind needs */
  start: string | null;
  format?: string;
  digits?: number;
}

/** One parsed fence: its config or a human-readable error — the chart-block
    shape, so a broken fence renders in place and never takes its siblings
    down. */
export interface ProgressBlock {
  config: ProgressConfig | null;
  error: string | null;
}

// ---------- config parsing ----------

const KNOWN_KEYS = new Set([
  "label",
  "value",
  "source",
  "query",
  "target",
  "deadline",
  "start",
  "format",
  "digits",
]);

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

function parseTarget(v: string): ProgressConfig["target"] {
  if (parseBind(v)) return { kind: "bind", bind: v };
  if (!NUMBER_RE.test(v)) {
    throw new Error(`target must be a positive number or {{Sheet.summary}} — got "${v}"`);
  }
  const n = Number(v);
  if (!isFinite(n) || n <= 0) throw new Error(`target must be greater than zero — got "${v}"`);
  return { kind: "number", n };
}

function parseDay(key: string, v: string): string {
  if (!isIsoDate(v)) throw new Error(`${key} must be a YYYY-MM-DD date — got "${v}"`);
  return v;
}

/** Parse one fence body; throws on any malformed line or missing key. The
    fence is hand-written text a person edits, so every mistake gets named. */
export function parseProgressConfig(inner: string): ProgressConfig {
  const kv = new Map<string, string>();
  for (const rawLine of inner.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(line);
    if (!m) throw new Error(`can't parse line: ${line}`);
    const key = m[1].toLowerCase();
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`unknown key "${m[1]}" — progress takes ${[...KNOWN_KEYS].join(", ")}`);
    }
    if (kv.has(key)) throw new Error(`duplicate key "${m[1]}"`);
    const value = unquote(m[2]);
    if (value === "") throw new Error(`"${m[1]}" needs a value`);
    kv.set(key, value);
  }
  for (const req of ["value", "target"]) {
    if (!kv.has(req)) throw new Error(`missing required key "${req}"`);
  }

  const raw = kv.get("value")!;
  let value: ProgressValue;
  if (raw.toLowerCase() === "count") {
    if (!kv.has("source")) throw new Error(`value: count needs a source — name a database`);
    const source = parseSource(kv.get("source")!);
    if (source.kind !== "sheet") {
      value = { kind: "count", source, query: kv.get("query") ?? null };
    } else {
      throw new Error(
        `count reads a database — bind a sheet with value: {{${source.name}.summary}} instead`
      );
    }
  } else if (parseBind(raw)) {
    if (kv.has("source")) throw new Error("source only applies to value: count");
    if (kv.has("query")) throw new Error("query only applies to value: count");
    value = { kind: "bind", bind: raw };
  } else {
    throw new Error(`value must be count or {{Sheet.summary}} — got "${raw}"`);
  }

  const digitsRaw = kv.get("digits");
  if (digitsRaw !== undefined && !/^\d+$/.test(digitsRaw)) {
    throw new Error(`digits must be a whole number — got "${digitsRaw}"`);
  }
  const format = kv.get("format")?.toLowerCase();
  if (format !== undefined && !CARD_FORMATS.includes(format)) {
    throw new Error(`unknown format "${kv.get("format")}" — want ${CARD_FORMATS.join(", ")}`);
  }
  const deadline = kv.has("deadline") ? parseDay("deadline", kv.get("deadline")!) : null;
  const start = kv.has("start") ? parseDay("start", kv.get("start")!) : null;
  // a start with no deadline has no line to sit on — the pace read is the
  // pair, so half of it is a mistake worth naming rather than ignoring
  if (start !== null && deadline === null) {
    throw new Error("start needs a deadline — the two mark the ends of the pace line");
  }
  if (start !== null && deadline !== null && daysBetween(start, deadline) <= 0) {
    throw new Error(`start must fall before the deadline — got ${start} and ${deadline}`);
  }

  return {
    label: kv.get("label") ?? null,
    value,
    target: parseTarget(kv.get("target")!),
    deadline,
    start,
    ...(format !== undefined ? { format } : {}),
    ...(digitsRaw !== undefined ? { digits: Number(digitsRaw) } : {}),
  };
}

/** Human label without making `label:` part of the required fence contract. */
export function progressLabel(config: ProgressConfig): string {
  if (config.label) return config.label;
  if (config.value.kind === "count") return `${config.value.source.type} count`;
  const bind = parseBind(config.value.bind);
  const raw = bind?.name ?? "progress";
  return raw.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** All ```progress fences in a note body, in order. Never throws. */
export function parseProgressBlocks(body: string): ProgressBlock[] {
  const re = /```progress\r?\n([\s\S]*?)```/g;
  const out: ProgressBlock[] = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    try {
      out.push({ config: parseProgressConfig(m[1]), error: null });
    } catch (e) {
      out.push({ config: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Every sheet a fence's binds name, deduped case-insensitively — the loader's
    work list. */
export function progressSheets(configs: ProgressConfig[]): string[] {
  const binds: string[] = [];
  for (const c of configs) {
    if (c.value.kind === "bind") binds.push(c.value.bind);
    if (c.target.kind === "bind") binds.push(c.target.bind);
  }
  return bindSheets(binds);
}

// ---------- value resolution ----------

/** The row count a `value: count` fence stands for: the same query the ```view
    fence runs, reported as its total. Display caps are zeroed — the fence
    wants the count, not the rows. */
export function progressCount(
  config: ProgressConfig,
  notes: NoteMeta[],
  schema: SchemaConfig
): { count: number } | { error: string } {
  if (config.value.kind !== "count") return { error: "not a count fence" };
  const result = embedQueryFor(
    { type: config.value.source.type, ...(config.value.query ? { query: config.value.query } : {}) },
    notes,
    schema,
    [],
    { cols: 0, rows: 0 }
  );
  return "error" in result ? { error: result.error } : { count: result.total };
}

// ---------- the bar ----------

/** Filled fraction, 0..1. Over-target clamps: the bar is full, and the text
    beside it carries the overshoot. */
export function progressFraction(value: number, target: number): number {
  if (!isFinite(value) || !isFinite(target) || target <= 0) return 0;
  return Math.max(0, Math.min(1, value / target));
}

/** Whole percent for the text read — unclamped, so 120 % of a gate says so. */
export function progressPercent(value: number, target: number): number {
  if (!isFinite(value) || !isFinite(target) || target <= 0) return 0;
  return Math.round((value / target) * 100);
}

// ---------- pace ----------

export interface ProgressPace {
  /** deadline − today, in calendar days; negative once it has passed */
  daysLeft: number;
  /** how much of the target is still missing (never negative) */
  remaining: number;
  /** the per-day rate that still lands on target; null once the deadline is
      here or gone, or when nothing is left to do */
  requiredPerDay: number | null;
  /** where the start→deadline line says the value should stand today; null
      without a `start:` anchor — the vault records no history to infer it */
  expected: number | null;
  /** value − expected; null without a `start:` anchor */
  delta: number | null;
}

/** Pace against the deadline. Pure calendar arithmetic (daysBetween), so it is
    deterministic for a given day and can't drift across a DST boundary. */
export function progressPace(
  value: number,
  target: number,
  deadline: string,
  start: string | null,
  today: string
): ProgressPace {
  const daysLeft = daysBetween(today, deadline);
  const remaining = Math.max(0, target - value);
  const requiredPerDay = daysLeft > 0 && remaining > 0 ? remaining / daysLeft : null;
  let expected: number | null = null;
  if (start !== null) {
    const span = daysBetween(start, deadline);
    if (span > 0) {
      // before the start day nothing was expected yet; past the deadline the
      // whole target was — the line ends where it ends, it doesn't extrapolate
      const elapsed = Math.max(0, Math.min(span, daysBetween(start, today)));
      expected = (target * elapsed) / span;
    }
  }
  return {
    daysLeft,
    remaining,
    requiredPerDay,
    expected,
    delta: expected === null ? null : value - expected,
  };
}

function daysPhrase(daysLeft: number): string {
  const n = Math.abs(daysLeft);
  const days = `${n} ${n === 1 ? "day" : "days"}`;
  if (daysLeft > 0) return `${days} left`;
  if (daysLeft === 0) return "due today";
  return `${days} past the deadline`;
}

/** The pace line's text, in the card's own number voice. Ahead/behind appears
    only when a `start:` anchor made it true; otherwise the line states the
    days left and the rate still required, and claims nothing about history. */
export function paceText(pace: ProgressPace, format?: string, digits?: number): string {
  const fmt = (n: number) => fmtCard(n, format, digits);
  const when = daysPhrase(pace.daysLeft);
  if (pace.remaining === 0) return `target reached · ${when}`;
  if (pace.delta !== null) {
    if (pace.delta === 0) return `on pace · ${when}`;
    return `${pace.delta > 0 ? "ahead by" : "behind by"} ${fmt(Math.abs(pace.delta))} · ${when}`;
  }
  if (pace.requiredPerDay !== null) return `${when} · ${fmt(pace.requiredPerDay)}/day to go`;
  return `${when} · ${fmt(pace.remaining)} to go`;
}
