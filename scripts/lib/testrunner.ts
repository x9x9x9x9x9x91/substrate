// Budgets and stall reporting for `npm test`.
//
// Why this exists: `node --test` defaults to no timeout at all, so one wedged
// test file freezes the whole suite silently and forever — a run on the dev
// Mac sat at 0.0% CPU for 47+ minutes with the log frozen mid-suite and had to
// be killed by hand. Two different bounds are needed, because they catch
// different failures:
//
//   * --test-timeout bounds a single test. It cancels an await that never
//     resolves (verified: a test blocked on `new Promise(() => {})` is
//     cancelled and the process exits).
//   * A wall-clock bound on the whole run is the only thing that catches a
//     test blocked inside a SYNCHRONOUS child process (execFileSync/spawnSync,
//     which several script suites use). That blocks the event loop, so the
//     runner's own timer never fires — --test-timeout is powerless there
//     (verified: a test doing `spawnSync("sleep", ["600"])` survives
//     --test-timeout=8000 indefinitely).
//
// When the wall-clock bound fires we print the live descendant process tree
// before killing it: with process isolation each `node --test` child names its
// test file in argv, and its own children name the command that wedged (a git
// call, a shell script), which is the evidence a stalled run otherwise costs a
// `sample` run to recover.

import { coverageArgs } from "./coverage.ts";

/** Milliseconds allowed for a single test before node cancels it. */
export const DEFAULT_PER_TEST_MS = 300_000;

/**
 * Milliseconds allowed for the whole suite before the runner kills it.
 *
 * Sized off observation, not taste: a healthy `npm test` is ~566s, but the same
 * suite took 2151s on a loaded gate machine. 90 min keeps ~2.5x
 * headroom over that worst case — ~2.3x against the 2200-2400s legs the rigs
 * actually show — because killing a slow-but-working run is a worse failure
 * than catching a wedged one late: a wedge burns the budget either way, a
 * false kill destroys real work.
 */
export const DEFAULT_SUITE_MS = 5_400_000;

/** Exit code for a run the watchdog killed — GNU timeout's convention. */
export const TIMEOUT_EXIT_CODE = 124;

export type Budgets = { perTestMs: number; suiteMs: number };

export type ProcessRow = { pid: number; ppid: number; command: string };

/**
 * The largest delay a timer can actually hold. `setTimeout` (and node's own
 * `--test-timeout`) stores the delay in a 32-bit signed integer, so anything
 * larger silently becomes 1ms: asking for a 25-day budget would kill the suite
 * roughly instantly, with exit 124 blaming a timeout that never really ran.
 * A budget too big to honour is rejected rather than clamped — someone who
 * wants "effectively no bound" means `0`, which turns the bound off outright.
 */
export const MAX_BUDGET_MS = 2_147_483_647;

function parseBudget(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number of milliseconds (0 disables the bound), got: ${raw}`);
  }
  if (value > MAX_BUDGET_MS) {
    throw new Error(
      `${name} must be at most ${MAX_BUDGET_MS} ms (~24.8 days) — a timer cannot hold more, ` +
        `and a larger value would fire almost immediately. Use 0 to disable the bound. Got: ${raw}`,
    );
  }
  return value;
}

/**
 * Read both budgets from the environment. `0` disables a bound deliberately —
 * useful when bisecting a genuinely slow suite — and anything unparseable is a
 * loud error rather than a silent fallback to the default.
 */
export function resolveBudgets(env: Record<string, string | undefined>): Budgets {
  return {
    perTestMs: parseBudget("SUBSTRATE_TEST_TIMEOUT_MS", env.SUBSTRATE_TEST_TIMEOUT_MS, DEFAULT_PER_TEST_MS),
    suiteMs: parseBudget("SUBSTRATE_SUITE_TIMEOUT_MS", env.SUBSTRATE_SUITE_TIMEOUT_MS, DEFAULT_SUITE_MS),
  };
}

/**
 * Test files that may run at once. `node --test` parallelises across FILES —
 * one process per file, cases inside a file stay sequential — and defaults to
 * (cpu count - 1). That default is right on a dedicated gate box and wrong on
 * the dev Mac, where a full-width suite competes with Ableton for the same
 * cores; a 2-vCPU VPS wants the opposite nudge. `0` (the default) keeps node's
 * own choice rather than pinning a number this file cannot know.
 */
export function resolveConcurrency(env: Record<string, string | undefined>): number {
  const raw = env.SUBSTRATE_TEST_CONCURRENCY;
  if (raw === undefined || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(
      `SUBSTRATE_TEST_CONCURRENCY must be a whole number of test files (0 keeps node's default), got: ${raw}`,
    );
  }
  return value;
}

/**
 * Where a coverage run writes its raw output, or undefined for a plain run.
 *
 * Coverage is opt-in through this one variable and nothing else, so the bare
 * `npm test` argv is byte-for-byte what it was before coverage existed:
 * instrumentation costs wall clock, and the suite is already the machine-heavy
 * half of a gate run. `npm run coverage` sets it; nothing else does.
 */
export function resolveCoverageDir(env: Record<string, string | undefined>): string | undefined {
  const raw = env.SUBSTRATE_COVERAGE_DIR;
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

/** The argv for the `node --test` run, with the per-test bound applied. */
export function buildNodeArgs(files: string[], budgets: Budgets, concurrency = 0, coverageDir?: string): string[] {
  const args = ["--test"];
  if (budgets.perTestMs > 0) args.push(`--test-timeout=${budgets.perTestMs}`);
  if (concurrency > 0) args.push(`--test-concurrency=${concurrency}`);
  if (coverageDir !== undefined) args.push(...coverageArgs(coverageDir));
  return [...args, ...files];
}

/**
 * Parse `ps -Ao pid,ppid,command` output. Malformed lines (including the
 * header) are skipped rather than throwing — this runs while we are already
 * reporting a failure, and a diagnostic that itself crashes helps nobody.
 */
export function parseProcessRows(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/**
 * Every descendant of `rootPid`, parents before children. Cycles in the ppid
 * table (impossible in practice, cheap to guard) cannot loop this.
 */
export function descendantsOf(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const found: ProcessRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** The block printed when the wall-clock bound fires, before we kill anything. */
export function formatStallReport(budgets: Budgets, live: ProcessRow[]): string {
  const minutes = (budgets.suiteMs / 60_000).toFixed(1);
  const lines = [
    "",
    `test suite exceeded its wall-clock budget of ${minutes} min — killing it.`,
    "",
    "Still running when the budget ran out (each `node --test` child names its",
    "test file; its own children name the command that wedged):",
  ];
  if (live.length === 0) {
    lines.push("  (no live descendants — the run may have wedged in the parent itself)");
  } else {
    for (const row of live) lines.push(`  pid ${row.pid} (parent ${row.ppid})  ${row.command}`);
  }
  lines.push(
    "",
    "Raise or disable the budget with SUBSTRATE_SUITE_TIMEOUT_MS (ms, 0 = off);",
    "the per-test bound is SUBSTRATE_TEST_TIMEOUT_MS.",
    "",
  );
  return lines.join("\n");
}
