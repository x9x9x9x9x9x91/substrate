import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The library sells a hard wall-clock bound: the merge watchdog leans on it
// every five minutes so a wedged rig cannot wedge the tick. The bound only
// holds if the deadline takes out everything the command forked — a wrapper
// that leaves a grandchild holding stdout keeps a command substitution
// waiting on the pipe long after its parent is dead, which is how the
// deadline used to sail past unnoticed. That shape is the first case here.
//
// Self-protection: every probe runs detached, in its own process group, with
// an outer alarm on the node side that SIGKILLs the group. A regression in
// the library fails this file at the alarm; subgroups the alarm cannot reach
// (the library's own `set -m` children) end with their probe commands, which
// are bounded at 60 s — a slow red, never a hung suite.

const LIB = fileURLToPath(new URL("./hard-timeout.sh", import.meta.url));

const OUTER_ALARM_MS = 30_000;

/**
 * Run a bash probe that sources the library, under an independent alarm.
 * Returns its stdout; a probe that outlives the alarm fails the test rather
 * than stalling the runner.
 */
function runProbe(body: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "hard-timeout-"));
  const probe = join(dir, "probe.sh");
  writeFileSync(probe, `#!/usr/bin/env bash\n. ${JSON.stringify(LIB)}\ncd ${JSON.stringify(dir)}\n${body}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn("bash", [probe], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", () => {});
    const alarm = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, OUTER_ALARM_MS);
    child.on("close", () => {
      clearTimeout(alarm);
      rmSync(dir, { recursive: true, force: true });
      if (timedOut) reject(new Error(`probe outlived its ${OUTER_ALARM_MS} ms alarm; output so far: ${out}`));
      else resolve(out);
    });
    child.on("error", (err) => { clearTimeout(alarm); reject(err); });
  });
}

/** `key=value` lines out of a probe, so one probe can report several facts. */
function fields(out: string): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
  }
  return seen;
}

// The wrapper the issue's repro used: it forks `sleep`, keeps its own stdout,
// and waits. Killing only the wrapper leaves the sleep holding the pipe.
const WRAPPER = [
  "cat > wrapper.sh <<'W'",
  "#!/usr/bin/env bash",
  "sleep 60 &",
  "wait",
  "W",
  "chmod +x wrapper.sh",
].join("\n");

test("a wrapper's surviving grandchild cannot hold a command substitution past the deadline", async () => {
  const out = await runProbe([
    WRAPPER,
    "start=$SECONDS",
    "rc=0",
    'captured="$(substrate_run_with_timeout 3 ./wrapper.sh)" || rc=$?',
    'echo "rc=$rc"',
    'echo "elapsed=$((SECONDS - start))"',
  ].join("\n"));

  const got = fields(out);
  assert.equal(got.rc, "124", `expected the timeout code, got ${JSON.stringify(out)}`);
  assert.ok(Number(got.elapsed) <= 8, `deadline was 3s, substitution returned after ${got.elapsed}s`);
});

test("a plain hung child still times out at the deadline", async () => {
  const out = await runProbe([
    "start=$SECONDS",
    "rc=0",
    "substrate_run_with_timeout 3 sleep 60 || rc=$?",
    'echo "rc=$rc"',
    'echo "elapsed=$((SECONDS - start))"',
  ].join("\n"));

  const got = fields(out);
  assert.equal(got.rc, "124");
  assert.ok(Number(got.elapsed) <= 8, `expected the kill at 3s, took ${got.elapsed}s`);
});

test("a command that finishes in time keeps its own exit code and output", async () => {
  const out = await runProbe([
    "start=$SECONDS",
    "rc=0",
    'captured="$(substrate_run_with_timeout 10 echo hello)" || rc=$?',
    'echo "rc=$rc"',
    'echo "captured=$captured"',
    "rc=0",
    "substrate_run_with_timeout 10 bash -c 'exit 7' || rc=$?",
    'echo "failing=$rc"',
    'echo "elapsed=$((SECONDS - start))"',
  ].join("\n"));

  const got = fields(out);
  assert.equal(got.rc, "0");
  assert.equal(got.captured, "hello");
  assert.equal(got.failing, "7", "a real exit code must come home unchanged");
  assert.ok(Number(got.elapsed) <= 5, "a finished command must not wait out its deadline");
});

test("the caller's job-control setting survives the call", async () => {
  const out = await runProbe([
    "substrate_run_with_timeout 5 true",
    'case "$-" in *m*) echo "monitor=on" ;; *) echo "monitor=off" ;; esac',
    "set -m",
    "substrate_run_with_timeout 5 true",
    'case "$-" in *m*) echo "monitor_after_set=on" ;; *) echo "monitor_after_set=off" ;; esac',
  ].join("\n"));

  const got = fields(out);
  assert.equal(got.monitor, "off", "job control must be left as the caller had it");
  assert.equal(got.monitor_after_set, "on", "a caller that wanted job control must keep it");
});
