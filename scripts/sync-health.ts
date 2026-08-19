#!/usr/bin/env node
/**
 * Is this machine's vault still exchanging with its remote?
 *
 * The LAN mirror had an out-of-band answer to that: two repositories on one
 * disk, so a script could compare them and print `fresh` / `stale` /
 * `diverged` without touching the network or the app (see
 * `vault-sync-server/status.ts`). A hosted remote takes that away. There is no
 * second local copy to compare against, and the only thing that knows how the
 * last exchange went is the app — inside its own window, where a check on a
 * dashboard cannot see it.
 *
 * So the app writes down what it last knew, and this reads it. Every push and
 * pull folds a small record into device-local config: when it was attempted,
 * when each leg last actually got through, whether a merge is parked. This
 * script turns that record into one line and an exit code, on the same scale
 * the mirror check used, so whatever ran that can run this.
 *
 * Two things it deliberately does NOT do:
 *
 * - It never talks to the remote. No token, no address, no request. The app is
 *   the only thing that holds credentials, and a second thing that could reach
 *   the remote would be a second thing to keep a secret in.
 * - It never reports healthy for want of evidence. A record that is missing,
 *   unreadable, or older than the window is a RED answer with the age in it,
 *   because "the app has not synced in three days" and "the app has not
 *   written anything here" look identical from outside and are equally worth
 *   waking up for. Silence is the failure this exists to catch, so silence is
 *   never the passing case.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Exit codes, matching the mirror check's scale so a dashboard can branch the
    same way it always did: 0 fresh, 1 stale, 2 needs attention, 3 no answer. */
export const HEALTH_FRESH = 0;
export const HEALTH_STALE = 1;
export const HEALTH_ATTENTION = 2;
export const HEALTH_ERROR = 3;

export type HealthCode =
  | typeof HEALTH_FRESH
  | typeof HEALTH_STALE
  | typeof HEALTH_ATTENTION
  | typeof HEALTH_ERROR;

export interface HealthReport {
  code: HealthCode;
  /** One plain-text summary line, suitable for a dashboard or shell check. */
  line: string;
}

/** The on-disk record's shape. The app owns it; this only ever reads it. */
export interface HealthRecord {
  version: number;
  last_attempt_at: number;
  last_attempt_leg: string;
  last_attempt_ok: boolean;
  last_failure?: string;
  last_push_ok_at?: number | null;
  last_pull_ok_at?: number | null;
  last_push_fail_at?: number | null;
  last_pull_fail_at?: number | null;
  conflicted?: number;
}

/** The legs the app writes. Anything else came from a file this check was not
    pointed at, and echoing it verbatim would print whatever that file says. */
const KNOWN_LEGS = new Set(["push", "pull", "sync"]);

/** How far ahead of this machine's clock a stamp may sit before it is a clock
    problem rather than a sync one. Writes land a moment before a reader looks,
    and two machines' clocks drift by seconds; minutes ahead is neither. */
export const FUTURE_TOLERANCE_SECONDS = 5 * 60;

/** The version this reader understands. A record from a newer app is reported
    as unreadable rather than half-believed. */
export const HEALTH_RECORD_VERSION = 1;

export interface HealthWindows {
  /** how long a vault may go without a successful sync before it reads stale */
  staleAfterSeconds: number;
  /** …and before it reads as not syncing at all */
  downAfterSeconds: number;
}

/**
 * Defaults sized for a desktop that is closed overnight, not for the sync
 * lane's own cadence. The app pulls every few minutes while it is open, so a
 * window tight enough to match that would go red every night and mean nothing
 * by the second morning. Six hours is "you have used this machine today and it
 * did not sync"; a day is "this vault is not syncing".
 */
export const DEFAULT_WINDOWS: HealthWindows = {
  staleAfterSeconds: 6 * 60 * 60,
  downAfterSeconds: 24 * 60 * 60,
};

/** What reading the record file produced. Each failure is its own answer: a
    missing file and a corrupt one call for different things from a reader. */
export type ReadOutcome =
  | { kind: "ok"; record: HealthRecord }
  | { kind: "missing" }
  | { kind: "unreadable"; detail: string }
  | { kind: "unknown-version"; version: number };

/** Seconds as the coarsest unit that still says something: `4m`, `7h`, `3d`. */
export function humanizeAge(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 90) return `${safe}s`;
  if (safe < 90 * 60) return `${Math.round(safe / 60)}m`;
  if (safe < 48 * 60 * 60) return `${Math.round(safe / 3600)}h`;
  return `${Math.round(safe / 86_400)}d`;
}

/**
 * Accepts `45s`, `30m`, `6h`, `2d`, or a bare number of seconds. Durations get
 * typed by hand into a launchd plist or a dashboard config, and `21600` is the
 * kind of number nobody checks twice.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (!match) throw new Error(`not a duration: ${value} (use e.g. 30m, 6h, 2d, or plain seconds)`);
  const amount = Number(match[1]);
  const scale = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[match[2]] ?? 1;
  return amount * scale;
}

/** A timestamp the record carries, or undefined when that leg never got
    through. Zero and negative are treated as never: the app writes a real
    clock reading or nothing, and a 1970 stamp is a bug, not a sync. */
function stampOf(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function ageOf(stamp: number, now: number): number {
  return Math.max(0, now - stamp);
}

/** `last push 4m ago, last pull never` — the per-leg detail every line carries,
    because the two fail independently and which one is dead is the whole
    diagnosis. */
function legDetail(record: HealthRecord, now: number): string {
  const leg = (label: string, stamp: number | undefined) =>
    `last ${label} ${stamp === undefined ? "never" : `${humanizeAge(ageOf(stamp, now))} ago`}`;
  return `${leg("push", stampOf(record.last_push_ok_at))}, ${leg("pull", stampOf(record.last_pull_ok_at))}`;
}

/** The leg name as written, or `sync` for anything outside the known set. */
function legName(value: string): string {
  return KNOWN_LEGS.has(value) ? value : "sync";
}

/**
 * A leg whose most recent outcome was a failure, with how long ago that was.
 *
 * This is the half a freshness window cannot see. Push only fires when the
 * vault changed, so an old push success stamp is ordinary — a quiet week is
 * not a symptom — and the 5-minute auto-pull keeps the record's newest stamp
 * young whatever the push leg is doing. What separates the two is which of a
 * leg's own stamps is newer: a leg that last failed is dead until it says
 * otherwise, however healthy the machine looks through the other one.
 */
function failingLegs(record: HealthRecord, now: number): { leg: string; age: number }[] {
  const legs: [string, number | null | undefined, number | null | undefined][] = [
    ["push", record.last_push_fail_at, record.last_push_ok_at],
    ["pull", record.last_pull_fail_at, record.last_pull_ok_at],
  ];
  return legs.flatMap(([leg, failedAt, okAt]) => {
    const failed = stampOf(failedAt);
    if (failed === undefined) return [];
    const ok = stampOf(okAt);
    if (ok !== undefined && ok >= failed) return [];
    return [{ leg, age: ageOf(failed, now) }];
  });
}

/** Every stamp the record carries, by the name it carries it under, so a line
    about a skewed clock can say which one is wrong. */
function stampsOf(record: HealthRecord): [string, number | undefined][] {
  return [
    ["last_attempt_at", stampOf(record.last_attempt_at)],
    ["last_push_ok_at", stampOf(record.last_push_ok_at)],
    ["last_pull_ok_at", stampOf(record.last_pull_ok_at)],
    ["last_push_fail_at", stampOf(record.last_push_fail_at)],
    ["last_pull_fail_at", stampOf(record.last_pull_fail_at)],
  ];
}

/**
 * The whole verdict, as a pure function of the record and the clock.
 *
 * Precedence is by what a reader has to do about it, not by severity in the
 * abstract:
 *
 * 1. No record to read — nothing can be said, and saying nothing quietly is
 *    the failure mode this replaces.
 * 2. A stamp from the future. Every answer below is an age, and an age
 *    measured against a wrong clock is not a weaker answer but a meaningless
 *    one.
 * 3. A parked merge. It is the one state the app will not leave on its own:
 *    the timer lane stands down entirely while a merge is waiting, so every
 *    other symptom below is downstream of it, and the record stops updating
 *    from that moment.
 * 4. Nothing has succeeded inside the down window (or ever).
 * 5. Nothing has succeeded inside the stale window.
 * 6. A leg whose last word was a failure, or a last attempt that failed.
 * 7. Fresh.
 */
export function classifyHealth(
  outcome: ReadOutcome,
  now: number,
  windows: HealthWindows = DEFAULT_WINDOWS,
): HealthReport {
  if (outcome.kind === "missing") {
    return {
      code: HEALTH_ERROR,
      line: "error: no sync data on this machine — the app has never recorded a sync attempt here",
    };
  }
  if (outcome.kind === "unreadable") {
    return { code: HEALTH_ERROR, line: `error: sync data unreadable: ${outcome.detail}` };
  }
  if (outcome.kind === "unknown-version") {
    return {
      code: HEALTH_ERROR,
      line: `error: sync data is version ${outcome.version}, this check reads version ${HEALTH_RECORD_VERSION}`,
    };
  }

  const record = outcome.record;
  // A clock that ran ahead — a dead RTC, a VM resumed before NTP caught it —
  // writes a stamp this check would otherwise read as age zero for as long as
  // the file exists, because ages are clamped at zero and a stamp in the future
  // never ages into the window. That is a permanently green check on a machine
  // nobody is watching, and the only cure short of deleting the file is saying
  // so out loud.
  const ahead = stampsOf(record).filter(
    (entry): entry is [string, number] =>
      entry[1] !== undefined && entry[1] > now + FUTURE_TOLERANCE_SECONDS,
  );
  if (ahead.length > 0) {
    const worst = ahead.reduce((a, b) => (b[1] > a[1] ? b : a));
    return {
      code: HEALTH_ATTENTION,
      line: `attention: sync data is stamped ${humanizeAge(worst[1] - now)} in the future`
        + ` (${worst[0]}) — this machine's clock or the one that wrote the record is wrong,`
        + " and no freshness can be read from it until it is",
    };
  }

  const attemptAge = ageOf(record.last_attempt_at, now);
  const detail = legDetail(record, now);
  const conflicted = record.conflicted ?? 0;
  if (conflicted > 0) {
    const paths = conflicted === 1 ? "1 path" : `${conflicted} paths`;
    return {
      code: HEALTH_ATTENTION,
      line: `attention: sync is parked on ${paths} of a conflicted merge as of ${humanizeAge(attemptAge)} ago;`
        + ` nothing syncs until it is resolved in the app — ${detail}`,
    };
  }

  const succeeded = [stampOf(record.last_push_ok_at), stampOf(record.last_pull_ok_at)].filter(
    (stamp): stamp is number => stamp !== undefined,
  );
  if (succeeded.length === 0) {
    return {
      code: HEALTH_ATTENTION,
      line: `attention: no sync has ever succeeded on this machine; last attempt ${humanizeAge(attemptAge)} ago`
        + ` — ${detail}`,
    };
  }

  const successAge = ageOf(Math.max(...succeeded), now);
  if (successAge >= windows.downAfterSeconds) {
    return {
      code: HEALTH_ATTENTION,
      line: `attention: no successful sync in ${humanizeAge(successAge)}; this vault is not exchanging with the remote`
        + ` — ${detail}`,
    };
  }
  if (successAge >= windows.staleAfterSeconds) {
    return {
      code: HEALTH_STALE,
      line: `stale: no successful sync in ${humanizeAge(successAge)} — ${detail}`,
    };
  }
  const failing = failingLegs(record, now);
  if (failing.length > 0) {
    const named = failing
      .map((leg) => `the ${leg.leg} leg has been failing for ${humanizeAge(leg.age)}`)
      .join(", and ");
    return { code: HEALTH_STALE, line: `stale: ${named} — ${detail}` };
  }
  if (!record.last_attempt_ok) {
    const side = record.last_failure === "local" ? "on this machine" : "reaching the remote";
    return {
      code: HEALTH_STALE,
      line: `stale: the last ${legName(record.last_attempt_leg)} failed ${side},`
        + ` ${humanizeAge(attemptAge)} ago — ${detail}`,
    };
  }
  return {
    code: HEALTH_FRESH,
    line: `fresh: the last ${legName(record.last_attempt_leg)} succeeded ${humanizeAge(attemptAge)} ago`
      + ` — ${detail}`,
  };
}

/** Read the record without deciding anything about it. */
export async function readHealthRecord(path: string): Promise<ReadOutcome> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "unreadable", detail };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not the parser's message: it quotes the bytes it choked on, and the day
    // `--state` is pointed at the wrong file those bytes are whatever that file
    // holds, printed to a dashboard by a check that promised to read one number
    // and one timestamp.
    return { kind: "unreadable", detail: "the record is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unreadable", detail: "the record is not an object" };
  }
  const record = parsed as Partial<HealthRecord>;
  if (typeof record.version !== "number") {
    return { kind: "unreadable", detail: "the record carries no version" };
  }
  if (record.version !== HEALTH_RECORD_VERSION) {
    return { kind: "unknown-version", version: record.version };
  }
  if (typeof record.last_attempt_at !== "number" || typeof record.last_attempt_ok !== "boolean") {
    return { kind: "unreadable", detail: "the record is missing its last-attempt fields" };
  }
  return {
    kind: "ok",
    record: {
      ...record,
      version: record.version,
      last_attempt_at: record.last_attempt_at,
      last_attempt_leg:
        typeof record.last_attempt_leg === "string" ? legName(record.last_attempt_leg) : "sync",
      last_attempt_ok: record.last_attempt_ok,
    },
  };
}

/** Where the app keeps the record on macOS, by its own config-directory rule.
    The bundle identifier is read from the Tauri config rather than written
    here, so this script names whatever identifier the checkout it runs in
    actually builds with. */
export function defaultStatePath(home: string = homedir()): string {
  const conf = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/tauri.conf.json"), "utf8"),
  ) as { identifier?: string };
  const identifier = conf.identifier ?? "com.example.substrate";
  return join(home, "Library/Application Support", identifier, "vault-sync-health.json");
}

export interface HealthOptions {
  state: string;
  windows: HealthWindows;
}

export function parseHealthArgs(argv: string[], home: string = homedir()): HealthOptions {
  let state = "";
  const windows = { ...DEFAULT_WINDOWS };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };

    switch (argument) {
      case "--state":
        state = value();
        break;
      case "--stale-after":
        windows.staleAfterSeconds = parseDuration(value());
        break;
      case "--down-after":
        windows.downAfterSeconds = parseDuration(value());
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node sync-health.ts [--state <record.json>] [--stale-after 6h] [--down-after 24h]"
          + "  (exit 0 fresh, 1 stale, 2 needs attention, 3 no readable data)",
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- the case above ends in process.exit()
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (windows.downAfterSeconds < windows.staleAfterSeconds) {
    throw new Error("--down-after must not be shorter than --stale-after");
  }
  return { state: resolve(state || defaultStatePath(home)), windows };
}

export async function reportSyncHealth(options: HealthOptions, now: number): Promise<HealthReport> {
  return classifyHealth(await readHealthRecord(options.state), now, options.windows);
}

async function main(): Promise<void> {
  const options = parseHealthArgs(process.argv.slice(2));
  const report = await reportSyncHealth(options, Math.floor(Date.now() / 1000));
  console.log(report.line);
  process.exitCode = report.code;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = HEALTH_ERROR;
  });
}
