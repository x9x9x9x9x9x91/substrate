import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// with-gates-lock.sh is the one thing standing between a rig-less fallback
// and five parallel local gate suites freezing the Mac (docs/agent-friction.md
// 2026-07-31). Its contract: exactly one holder machine-wide, the wrapped
// command's exit code survives, the lock is released however the command
// ends, and a lock left by a DEAD owner is broken while a live one is not.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// The real script locks /tmp/substrate-gates.lock — machine-wide and shared
// with any gate run actually happening on this Mac. The rig runs a copy
// pointed at its own mkdtemp lock instead; the assertion below is what keeps
// that redirection from silently no-opping into the real lock if the script's
// LOCK line is ever reworded.
function makeRig(dir: string): { script: string; lock: string } {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "lib"), { recursive: true });
  const lock = join(dir, "gates.lock");
  const src = readFileSync(join(ROOT, "scripts/with-gates-lock.sh"), "utf8");
  const patched = src.replace('LOCK="/tmp/substrate-gates.lock"', `LOCK="${lock}"`);
  assert.notEqual(patched, src, "LOCK line not found — refusing to test against the real /tmp lock");
  const script = join(repo, "with-gates-lock.sh");
  writeFileSync(script, patched);
  writeFileSync(
    join(repo, "lib/checkout-guard.sh"),
    readFileSync(join(ROOT, "scripts/lib/checkout-guard.sh"), "utf8"),
  );
  return { script, lock };
}

type RunOpts = { env?: Record<string, string>; cwd?: string };

function runLock(script: string, inner: string, opts: RunOpts = {}) {
  return spawnSync("bash", [script, "bash", "-c", inner], {
    // outside a git repo the checkout guard bails early, which is what we
    // want: this suite is about the lock, not about checkout freshness
    cwd: opts.cwd ?? tmpdir(),
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
}

/** A lock directory as the script itself would leave one. */
function plantLock(lock: string, pid: number, startedSecondsAgo: number) {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), `pid ${pid} cwd /nowhere cmd planted\n`);
  writeFileSync(join(lock, "started"), `${Math.floor(Date.now() / 1000) - startedSecondsAgo}\n`);
}

/** A pid that is certainly not running: spawn true, wait for it to exit. */
function deadPid(): number {
  const res = spawnSync("bash", ["-c", 'exec bash -c \'echo $$\''], { encoding: "utf8" });
  return Number(res.stdout.trim());
}

type Rig = { script: string; lock: string; dir: string };

async function withRig(fn: (rig: Rig) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-gates-lock-"));
  try {
    await fn({ ...makeRig(dir), dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("acquires, runs the command, and releases the lock", async () => {
  await withRig((rig) => {
    const res = runLock(rig.script, `test -d "${rig.lock}" && echo held`);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /held/, "the command should run while the lock exists");
    assert.ok(!existsSync(rig.lock), "lock survived a successful run");
  });
});

test("the wrapped command's exit code is the wrapper's exit code", async () => {
  await withRig((rig) => {
    assert.equal(runLock(rig.script, "exit 7").status, 7);
    assert.equal(runLock(rig.script, "exit 0").status, 0);
  });
});

test("the lock is released when the wrapped command fails", async () => {
  await withRig((rig) => {
    assert.equal(runLock(rig.script, "exit 3").status, 3);
    assert.ok(!existsSync(rig.lock), "a failed command must not wedge the lock");
    // and the next run can take it straight away
    assert.equal(runLock(rig.script, "true").status, 0);
  });
});

test("no command is a usage error, and it takes no lock", async () => {
  await withRig((rig) => {
    const res = spawnSync("bash", [rig.script], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage:/);
    assert.ok(!existsSync(rig.lock));
  });
});

test("the owner file records the holder's pid, cwd and command", async () => {
  await withRig((rig) => {
    const res = runLock(rig.script, `cat "${rig.lock}/owner"`);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^pid \d+ cwd .* cmd bash -c cat /);
  });
});

test("a live holder keeps the lock; the second run gives up with exit 75", async () => {
  await withRig(async (rig) => {
    const holder = spawn("bash", [rig.script, "sleep", "30"], { cwd: tmpdir(), stdio: "ignore" });
    try {
      await waitFor(() => existsSync(join(rig.lock, "owner")));
      // GATES_LOCK_WAIT_MIN=0 puts the deadline in the past, so the refusal
      // is immediate instead of polling for 45 minutes
      const res = runLock(rig.script, "echo SHOULD-NOT-RUN", { env: { GATES_LOCK_WAIT_MIN: "0" } });
      assert.equal(res.status, 75, "a contended run must exit 75, not run");
      assert.doesNotMatch(res.stdout, /SHOULD-NOT-RUN/, "two gate suites ran at once");
      assert.match(res.stderr, /gave up after 0m/);
      assert.match(res.stderr, /owner pid \d+/, "the refusal should name the holder");
      assert.ok(existsSync(rig.lock), "the live holder's lock must survive the refusal");
    } finally {
      holder.kill("SIGTERM");
      await once(holder);
    }
  });
});

test("a FRESH lock left by a dead pid is respected, not stolen", async () => {
  await withRig((rig) => {
    // freshness wins over liveness: a lock seconds old is one that was just
    // taken, and the pid read may simply have raced the owner file's write
    plantLock(rig.lock, deadPid(), 5);
    const res = runLock(rig.script, "echo SHOULD-NOT-RUN", { env: { GATES_LOCK_WAIT_MIN: "0" } });
    assert.equal(res.status, 75);
    assert.doesNotMatch(res.stdout, /SHOULD-NOT-RUN/);
    assert.ok(existsSync(rig.lock));
  });
});

test("an OLD lock whose owner is dead is broken and the run proceeds", async () => {
  await withRig((rig) => {
    plantLock(rig.lock, deadPid(), 5401); // just past the 90-minute backstop
    const res = runLock(rig.script, "echo ran-after-steal", { env: { GATES_LOCK_WAIT_MIN: "0" } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ran-after-steal/);
    // the notice goes to stdout, not stderr — it lands in the gate log
    assert.match(res.stdout, /breaking stale lock/);
    assert.ok(!existsSync(rig.lock), "the stolen lock should be released again at exit");
  });
});

test("an OLD lock whose owner is ALIVE is respected — a long run is not a stale one", async () => {
  await withRig(async (rig) => {
    const live = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      plantLock(rig.lock, live.pid!, 99999);
      const res = runLock(rig.script, "echo SHOULD-NOT-RUN", { env: { GATES_LOCK_WAIT_MIN: "0" } });
      assert.equal(res.status, 75, "breaking this lock would stack a second suite on a live one");
      assert.doesNotMatch(res.stdout, /SHOULD-NOT-RUN/);
      assert.doesNotMatch(res.stdout, /breaking stale lock/);
      assert.ok(existsSync(rig.lock));
    } finally {
      live.kill("SIGTERM");
      await once(live);
    }
  });
});

test("a lock mid-creation (no started file) is treated as fresh, never stale", async () => {
  await withRig((rig) => {
    mkdirSync(rig.lock, { recursive: true }); // won the mkdir, hasn't written yet
    const res = runLock(rig.script, "echo SHOULD-NOT-RUN", { env: { GATES_LOCK_WAIT_MIN: "0" } });
    assert.equal(res.status, 75);
    assert.doesNotMatch(res.stdout, /breaking stale lock/);
    assert.ok(existsSync(rig.lock));
  });
});

test("SIGTERM releases the lock and stops the wrapped command", async () => {
  await withRig(async (rig) => {
    const marker = join(rig.dir, "still-running");
    const child = spawn("bash", [rig.script, "bash", "-c", `sleep 30; touch "${marker}"`], {
      cwd: tmpdir(),
      stdio: "ignore",
    });
    await waitFor(() => existsSync(join(rig.lock, "owner")));
    child.kill("SIGTERM");
    const code = await once(child);
    assert.equal(code, 143, "the wrapper reports the signalled exit");
    assert.ok(!existsSync(rig.lock), "SIGTERM must release the lock, not wedge the machine");
    assert.ok(!existsSync(marker), "the wrapped command should have been killed too");
  });
});

/** Poll a cheap predicate; the timeout is a test-failure backstop, not a wait. */
async function waitFor(pred: () => boolean, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error("timed out waiting for the lock to be taken");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function once(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? 143);
  }
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 143 : null))));
}
