#!/usr/bin/env node
/**
 * coverage-report.ts — `npm run coverage`.
 *
 * Runs the node test battery under V8 coverage and writes a ranked
 * least-covered view beside the raw lcov. Nothing here gates anything: there
 * is no threshold, no floor, and no exit code that depends on a percentage.
 * The deliverable is visibility — which parts of the tree no test executes —
 * for a review or prune pass to read.
 *
 * WHY IT IS NOT `npm test`. Instrumentation costs wall clock on a suite that
 * is already the machine-heavy half of a gate run, and the gates run it on
 * every branch. So coverage is a separate command that sets one variable
 * (SUBSTRATE_COVERAGE_DIR) the runner reads; with it unset the suite's argv is
 * unchanged. The nightly mac pass calls this and publishes the output.
 *
 * Usage:
 *   npm run coverage                  # report into coverage/
 *   npm run coverage -- --out <dir>   # elsewhere
 *   npm run coverage -- --top 60      # deeper ranking in the printed view
 *
 * Output in the report directory:
 *   lcov.info         raw coverage, for any viewer that reads lcov
 *   test-run.log      the full spec log of the run (a failing test's detail)
 *   least-covered.md  the published report — headline numbers + ranking
 *   least-covered.json  every file, unranked, for a machine reader
 *
 * The suite's own exit code is passed through. A red suite still gets a
 * report, marked partial, because a run that only half-executed still says
 * something about what it did reach.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVERAGE_ROOTS,
  countSourceLines,
  formatRanking,
  formatReport,
  isMeasured,
  parseLcov,
  percent,
  rankLeastCovered,
  suiteDurationMs,
  withNeverLoaded,
  type FileCoverage,
} from "./lib/coverage.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

let outDir = "coverage";
let top = 40;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--out" && value !== undefined) {
    outDir = value;
    i += 1;
  } else if (flag === "--top" && value !== undefined) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`coverage-report: --top needs a positive whole number, got: ${value}`);
      process.exit(2);
    }
    top = parsed;
    i += 1;
  } else if (flag === "--out" || flag === "--top") {
    console.error(`coverage-report: ${flag} needs a value (flags: --out <dir> --top <n>)`);
    process.exit(2);
  } else {
    console.error(`coverage-report: unknown arg '${flag}' (flags: --out <dir> --top <n>)`);
    process.exit(2);
  }
}

mkdirSync(outDir, { recursive: true });

/**
 * Every measured source file in the tree, with its size.
 *
 * This is the half of the report the suite cannot supply. Node's
 * include-all walk reaches `.ts` only, so a `.tsx` no test ever imports is
 * absent from lcov entirely — and the components are exactly the surface the
 * report exists to make visible. Walking the tree here fills that in, using
 * the same predicate the coverage flags are built from.
 */
function inventory(): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(ROOT, full);
      if (!isMeasured(path)) continue;
      found.set(path, countSourceLines(readFileSync(full, "utf8")));
    }
  };
  for (const root of COVERAGE_ROOTS) walk(join(ROOT, root));
  return found;
}

const startedAt = Date.now();
console.log(`── coverage run: the node test battery under V8 coverage, report into ${outDir}/`);
const suite = spawnSync(process.execPath, ["scripts/run-node-tests.ts"], {
  stdio: "inherit",
  env: { ...process.env, SUBSTRATE_COVERAGE_DIR: outDir },
});
const wallClockS = Math.round((Date.now() - startedAt) / 1000);
const testExitCode = suite.status ?? 1;

if (suite.error) {
  console.error(`coverage-report: could not start the suite — ${suite.error.message}`);
  process.exit(1);
}

const lcovPath = join(outDir, "lcov.info");
let lcov = "";
try {
  lcov = readFileSync(lcovPath, "utf8");
} catch {
  console.error(
    `coverage-report: the run wrote no ${lcovPath} — it was killed before the reporter flushed, ` +
      `or the node in use predates the lcov reporter. Nothing to report on.`,
  );
  process.exit(testExitCode === 0 ? 1 : testExitCode);
}

const files: FileCoverage[] = withNeverLoaded(parseLcov(lcov), inventory());

/* The runner re-execs under the machine-wide gates lock, so the wall clock
   around it includes lock wait — on a contended box that published a 2.3×
   overstatement of the one number a reader uses to decide whether the pass
   is affordable. The suite's own summary in test-run.log is the instrumented
   cost; the wall clock only stands in when the log yields no summary. */
let suiteMs: number | undefined;
try {
  suiteMs = suiteDurationMs(readFileSync(join(outDir, "test-run.log"), "utf8"));
} catch {
  /* no log, wall clock stands in */
}
const durationS = suiteMs !== undefined ? Math.round(suiteMs / 1000) : wallClockS;

const context = {
  commit: gitHead(),
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  durationS,
  testExitCode,
  rankingLimit: top,
};

writeFileSync(join(outDir, "least-covered.md"), formatReport(files, context));
writeFileSync(
  join(outDir, "least-covered.json"),
  `${JSON.stringify({ ...context, files: rankLeastCovered(files) }, null, 2)}\n`,
);

const lines = files.reduce((total, file) => total + file.lines, 0);
const covered = files.reduce((total, file) => total + file.covered, 0);
const neverLoaded = files.filter((file) => !file.loaded).length;

console.log("");
console.log(`── ${files.length} files, ${neverLoaded} that no test loaded`);
console.log(`── lines ${covered}/${lines} covered (${percent(covered, lines).toFixed(1)}%) in ${durationS}s`);
if (testExitCode !== 0) {
  console.log(`── the suite exited ${testExitCode} — these numbers are PARTIAL; detail in ${outDir}/test-run.log`);
}
console.log("");
console.log(`── least covered, top ${Math.min(top, files.length)} by uncovered lines:`);
console.log(formatRanking(files, top));
console.log("");
console.log(`── report: ${join(outDir, "least-covered.md")} (report only — no threshold, nothing gated)`);

process.exit(testExitCode);

/** The commit the report describes, or a placeholder outside a git checkout. */
function gitHead(): string {
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = typeof rev.stdout === "string" ? rev.stdout.trim() : "";
  return rev.status === 0 && sha !== "" ? sha : "unknown";
}
