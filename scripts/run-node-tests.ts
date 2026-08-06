import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildNodeArgs,
  descendantsOf,
  formatStallReport,
  parseProcessRows,
  resolveBudgets,
  TIMEOUT_EXIT_CODE,
  type Budgets,
} from "./lib/testrunner.ts";

// Keep the suite's topology explicit. Shell globs that match nothing are
// passed literally to `node --test`, which exits successfully with zero tests;
// checking each root here turns a missing/excluded suite into a loud failure.
const roots = [
  "src/lib",
  "scripts",
  "scripts/lib",
  "scripts/vault-sync-server",
  "scripts/handoff-relay",
];

const files: string[] = [];
for (const root of roots) {
  let matches: string[];
  try {
    matches = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`test suite root is missing or unreadable: ${root}\n${detail}`);
    process.exit(1);
  }
  if (matches.length === 0) {
    console.error(`test suite root matched no *.test.ts files: ${root}`);
    process.exit(1);
  }
  files.push(...matches);
}

let budgets: Budgets;
try {
  budgets = resolveBudgets(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const child = spawn(process.execPath, buildNodeArgs(files, budgets), { stdio: "inherit" });

// The suite watchdog. `--test-timeout` alone cannot save a run: a test blocked
// inside a synchronous child process (execFileSync/spawnSync) never yields the
// event loop, so node's own per-test timer never fires and the suite sits at
// 0% CPU indefinitely. Only an outside observer can end that, so it lives here
// in the parent — which stays idle for exactly this reason.
const watchdog =
  budgets.suiteMs > 0
    ? setTimeout(() => {
        const ps = spawnSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf8" });
        const rows = typeof ps.stdout === "string" ? parseProcessRows(ps.stdout) : [];
        const live = child.pid === undefined ? [] : descendantsOf(rows, child.pid);
        console.error(formatStallReport(budgets, live));
        // Children first: killing the runner first would reparent a wedged git
        // or shell to init, where nothing is left holding its pid.
        for (const row of [...live].reverse()) {
          try {
            process.kill(row.pid, "SIGKILL");
          } catch {
            // Already gone between the `ps` and here — nothing to do.
          }
        }
        child.kill("SIGKILL");
        process.exit(TIMEOUT_EXIT_CODE);
      }, budgets.suiteMs)
    : undefined;

child.on("error", (error) => {
  if (watchdog) clearTimeout(watchdog);
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (watchdog) clearTimeout(watchdog);
  if (signal) {
    console.error(`test run terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
