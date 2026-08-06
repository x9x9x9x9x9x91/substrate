import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNodeArgs,
  DEFAULT_PER_TEST_MS,
  DEFAULT_SUITE_MS,
  descendantsOf,
  formatStallReport,
  MAX_BUDGET_MS,
  parseProcessRows,
  resolveBudgets,
  TIMEOUT_EXIT_CODE,
  type ProcessRow,
} from "./testrunner.ts";

// `npm test` wedged for 47+ minutes at 0% CPU with the log frozen
// mid-suite. Two bounds now guard it, and the tests below pin the property
// that made two bounds necessary rather than one: node's per-test timeout
// cancels a stuck await, but is powerless against a test blocked in a
// synchronous child spawn, which only an outside killer can end.

const budgets = { perTestMs: 1000, suiteMs: 2000 };

/**
 * Env for a nested `node --test` run. NODE_TEST_CONTEXT tells node it is a
 * reporting child of an outer run; inherited, it makes the nested run report
 * into our own results instead of behaving like the standalone suite we are
 * measuring.
 */
function nestedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("NODE_TEST_")) delete env[key];
  return env;
}

test("budgets default when unset and are overridable per bound", () => {
  assert.deepEqual(resolveBudgets({}), {
    perTestMs: DEFAULT_PER_TEST_MS,
    suiteMs: DEFAULT_SUITE_MS,
  });
  assert.deepEqual(resolveBudgets({ SUBSTRATE_TEST_TIMEOUT_MS: "5000" }), {
    perTestMs: 5000,
    suiteMs: DEFAULT_SUITE_MS,
  });
  // 0 is a deliberate opt-out (bisecting a genuinely slow suite), not junk.
  assert.equal(resolveBudgets({ SUBSTRATE_SUITE_TIMEOUT_MS: "0" }).suiteMs, 0);
});

test("an unparseable budget fails loudly instead of silently defaulting", () => {
  for (const raw of ["abc", "-1", "1.5", "10min"]) {
    assert.throws(() => resolveBudgets({ SUBSTRATE_SUITE_TIMEOUT_MS: raw }), /whole number of milliseconds/);
  }
});

test("a budget too large for a 32-bit timer is rejected, not silently instant", () => {
  // The failure this guards: setTimeout stores the delay in a 32-bit signed
  // int, so MAX+1 becomes 1ms — the watchdog would fire immediately and exit
  // 124, blaming a timeout on a suite that never got to run. Both sides of the
  // boundary are pinned because the interesting value is the largest legal one.
  assert.equal(MAX_BUDGET_MS, 2 ** 31 - 1);
  const bounds = [
    ["SUBSTRATE_SUITE_TIMEOUT_MS", "suiteMs"],
    ["SUBSTRATE_TEST_TIMEOUT_MS", "perTestMs"],
  ] as const;
  for (const [envName, field] of bounds) {
    assert.equal(resolveBudgets({ [envName]: String(MAX_BUDGET_MS) })[field], MAX_BUDGET_MS);
    for (const over of [String(MAX_BUDGET_MS + 1), "999999999999"]) {
      assert.throws(() => resolveBudgets({ [envName]: over }), /at most 2147483647 ms/);
    }
  }
});

test("the runner passes a real per-test timeout, and omits it when disabled", () => {
  assert.deepEqual(buildNodeArgs(["a.test.ts"], budgets), ["--test", "--test-timeout=1000", "a.test.ts"]);
  assert.deepEqual(buildNodeArgs(["a.test.ts"], { perTestMs: 0, suiteMs: 0 }), ["--test", "a.test.ts"]);
});

test("process rows parse, skipping the ps header and any malformed line", () => {
  const rows = parseProcessRows(
    ["  PID  PPID COMMAND", "  101     1 /usr/bin/node --test a.test.ts", "garbage", " 202   101 git clone https://x  "].join(
      "\n",
    ),
  );
  assert.deepEqual(rows, [
    { pid: 101, ppid: 1, command: "/usr/bin/node --test a.test.ts" },
    { pid: 202, ppid: 101, command: "git clone https://x" },
  ]);
});

test("descendants are found transitively and a ppid cycle cannot loop", () => {
  const rows: ProcessRow[] = [
    { pid: 2, ppid: 1, command: "node --test" },
    { pid: 3, ppid: 2, command: "bash share-mirror.sh" },
    { pid: 4, ppid: 3, command: "git ls-remote" },
    { pid: 9, ppid: 1, command: "unrelated" },
    // A `ps` snapshot can contain a reused pid, which would close a loop.
    { pid: 3, ppid: 4, command: "same pid seen again" },
  ];
  assert.deepEqual(
    descendantsOf(rows, 2).map((row) => row.pid),
    [3, 4],
  );
});

test("the stall report names the budget and every live process", () => {
  const report = formatStallReport({ perTestMs: 1000, suiteMs: 2_700_000 }, [
    { pid: 3, ppid: 2, command: "node --test scripts/share-mirror.test.ts" },
  ]);
  assert.match(report, /45\.0 min/);
  assert.match(report, /pid 3 \(parent 2\)\s+node --test scripts\/share-mirror\.test\.ts/);
  assert.match(report, /SUBSTRATE_SUITE_TIMEOUT_MS/);

  assert.match(formatStallReport(budgets, []), /no live descendants/);
});

test("--test-timeout cancels a test stuck on an await that never resolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "testrunner-await-"));
  try {
    const file = join(dir, "stuck.test.ts");
    writeFileSync(file, 'import { test } from "node:test";\ntest("never resolves", async () => { await new Promise(() => {}); });\n');
    const run = spawnSync(process.execPath, buildNodeArgs([file], { perTestMs: 2000, suiteMs: 0 }), {
      encoding: "utf8",
      timeout: 60_000,
      env: nestedEnv(),
    });
    assert.notEqual(run.status, 0, "a test that never finishes must not pass");
    assert.match(`${run.stdout}${run.stderr}`, /timed out after 2000ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test blocked in a synchronous spawn survives --test-timeout, and only the tree kill ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "testrunner-sync-"));
  const file = join(dir, "sync.test.ts");
  writeFileSync(
    file,
    'import { test } from "node:test";\nimport { spawnSync } from "node:child_process";\ntest("blocks the event loop", () => { spawnSync("sleep", ["120"]); });\n',
  );
  // stdio ignored so the child's own test output cannot interleave with ours.
  const child = spawn(process.execPath, buildNodeArgs([file], { perTestMs: 500, suiteMs: 0 }), {
    stdio: "ignore",
    env: nestedEnv(),
  });
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  try {
    const sleepPid = await waitFor(() => {
      const rows = parseProcessRows(spawnSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf8" }).stdout ?? "");
      return descendantsOf(rows, child.pid as number).find((row) => /\bsleep 120\b/.test(row.command))?.pid;
    });

    // Well past the 500ms per-test bound: node cannot preempt a blocked
    // synchronous spawn, which is exactly why the suite watchdog exists.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(child.exitCode, null, "the per-test timeout should NOT have been able to end this run");

    // What the watchdog does: children first, then the runner.
    process.kill(sleepPid, "SIGKILL");
    child.kill("SIGKILL");
    await exited;
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exit code is the entire contract with verify-gates.sh: a watchdog kill
// has to be distinguishable from an ordinary test failure, and only a real run
// of the runner proves that end to end. The suite it runs is a temp fixture,
// not this repo's own — the runner reads its roots relative to cwd, so pointing
// cwd at a fixture tree exercises the real script against a suite of one
// deliberately wedged test, with no recursion into the suite we are part of.
test("the runner exits 124 end-to-end when the suite budget kills a wedged run", () => {
  const marker = "1847"; // A sleep duration nothing else on the machine uses.
  const runner = join(dirname(dirname(fileURLToPath(import.meta.url))), "run-node-tests.ts");
  const dir = mkdtempSync(join(tmpdir(), "testrunner-e2e-"));
  try {
    // Every root the runner insists on, read from the runner itself: it exits 1
    // on a root that is missing or has no tests, and the list differs between
    // this repo and the stripped public mirror.
    const roots = [...readFileSync(runner, "utf8").matchAll(/^\s*"([^"]+)",$/gm)].map((m) => m[1]);
    assert.ok(roots.length > 0, "could not read the runner's suite roots");
    for (const root of roots) {
      mkdirSync(join(dir, root), { recursive: true });
      writeFileSync(join(dir, root, "ok.test.ts"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
    }
    // Blocked in a synchronous spawn: node's per-test bound cannot end this, so
    // reaching exit 124 proves the outer watchdog did the killing.
    writeFileSync(
      join(dir, roots[0], "wedged.test.ts"),
      'import { test } from "node:test";\nimport { spawnSync } from "node:child_process";\n' +
        `test("wedges", () => { spawnSync("sleep", ["${marker}"]); });\n`,
    );

    const run = spawnSync(process.execPath, [runner], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...nestedEnv(), SUBSTRATE_SUITE_TIMEOUT_MS: "4000", SUBSTRATE_TEST_TIMEOUT_MS: "1000" },
    });

    // The literal is deliberate. Asserting against TIMEOUT_EXIT_CODE would
    // move with the constant and pin nothing: 124 is the number verify-gates.sh
    // and every stalled-run log are read against, so 124 is what is checked.
    assert.equal(TIMEOUT_EXIT_CODE, 124, "the watchdog's exit code is a published contract, not an internal choice");
    assert.equal(run.status, 124, `expected the watchdog's exit code\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /exceeded its wall-clock budget/);
    // The stall report has to name the wedge, or the log is not diagnosable.
    assert.match(run.stderr, new RegExp(`sleep ${marker}`));
  } finally {
    // The runner kills its own tree; this only catches a leak if it did not.
    const rows = parseProcessRows(spawnSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf8" }).stdout ?? "");
    for (const row of rows) {
      if (new RegExp(`\\bsleep ${marker}\\b`).test(row.command)) process.kill(row.pid, "SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Poll until `probe` returns a value, or fail — never leave a wedged child. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, "timed out waiting for the blocked child process to appear");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
