import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The guard these hooks carry answers the 2026-08-22 stall: a session
// committed onto local main in the main worktree while another session held
// the merge lock, so the train's push aborted on an ungated rider and the
// recovery needed a hard reset nobody was allowed to run unattended.
//
// The properties under test are the ones that make it safe to install:
//   1. a commit on main under ANOTHER live holder's lock is refused;
//   2. the HOLDER's own commits still pass — both handshakes, the exported
//      token and process ancestry — because with-merge-lock runs the train's
//      merge commit under the lock it holds and a guard that broke that would
//      break every train;
//   3. no lock, or a dead holder's leftover lock, is not a refusal (the lock
//      script itself steals such a lock);
//   4. off main it never fires at all.
//
// Every rig is a real git repo with the real hooks symlinked into .git/hooks,
// so what is asserted is what git actually did with the commit.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRig(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts/git-hooks/lib"), { recursive: true });
  for (const hook of ["pre-commit", "pre-merge-commit"]) {
    cpSync(join(ROOT, "scripts/git-hooks", hook), join(repo, "scripts/git-hooks", hook));
  }
  cpSync(
    join(ROOT, "scripts/git-hooks/lib/merge-lock-guard.sh"),
    join(repo, "scripts/git-hooks/lib/merge-lock-guard.sh"),
  );

  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Lock Test");
  git(repo, "config", "user.email", "lock@example.test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "initial");

  for (const hook of ["pre-commit", "pre-merge-commit"]) {
    symlinkSync(join(repo, "scripts/git-hooks", hook), join(repo, ".git/hooks", hook));
  }
  return repo;
}

function writeLock(repo: string, pid: number | string) {
  const lock = join(repo, ".git/substrate-merge.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${pid}\n`);
  return lock;
}

// A process that is alive for the duration of one test and is NOT an ancestor
// of the commit under it — a foreign holder, which is the whole point.
function liveForeignHolder(): { pid: number; stop: () => void } {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  child.unref();
  return { pid: child.pid as number, stop: () => child.kill("SIGKILL") };
}

// A pid that has certainly exited: the shell that printed its own pid and
// then returned.
function deadPid(): number {
  const out = execFileSync("bash", ["-c", 'printf "%s" "$$"'], { encoding: "utf8" });
  return Number(out.trim());
}

function commit(repo: string, message: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", message], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const headSubject = (repo: string) => git(repo, "log", "-1", "--format=%s");

test("refuses a commit on main while another live process holds the merge lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    writeLock(repo, holder.pid);

    const result = commit(repo, "rider straight onto main");
    assert.notEqual(result.status, 0, "the commit should have been refused");
    assert.match(result.stderr, /refusing commit on main/);
    assert.match(result.stderr, new RegExp(`pid ${holder.pid}`));
    assert.match(result.stderr, /with-merge-lock\.sh --wait/);
    assert.equal(headSubject(repo), "initial", "main must not have moved");
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses the automatic merge commit too, not just plain commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    git(repo, "checkout", "-q", "-b", "sub/topic");
    git(repo, "commit", "-q", "--allow-empty", "-m", "topic work");
    git(repo, "checkout", "-q", "main");
    writeLock(repo, holder.pid);

    const merged = spawnSync("git", ["-C", repo, "merge", "--no-ff", "-m", "merge topic", "sub/topic"], {
      encoding: "utf8",
    });
    assert.notEqual(merged.status, 0, "the merge commit should have been refused");
    assert.match(merged.stderr, /refusing commit on main/);
    assert.equal(headSubject(repo), "initial", "main must not have moved");
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows a commit on main when no merge lock exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  try {
    const repo = makeRig(dir);
    const result = commit(repo, "unlocked commit");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headSubject(repo), "unlocked commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows the lock holder's own commit via the exported token", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    writeLock(repo, holder.pid);

    // What with-merge-lock.sh exports into its wrapped command: the pid the
    // lock file names. Without this the train's own merge commit would be
    // refused by its own lock.
    const result = commit(repo, "train merge under the lock", {
      SUBSTRATE_MERGE_LOCK_PID: String(holder.pid),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headSubject(repo), "train merge under the lock");
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows the lock holder's own commit via process ancestry with no token", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  try {
    const repo = makeRig(dir);
    const lock = join(repo, ".git/substrate-merge.lock");
    mkdirSync(lock, { recursive: true });

    // The shell claims the lock in its own name and then commits, exactly as
    // with-merge-lock does — but with the environment carrying nothing, so
    // only the ancestry handshake can let this through.
    const script = [
      `printf '%s\\n' "$$" > ${JSON.stringify(join(lock, "pid"))}`,
      `git -C ${JSON.stringify(repo)} commit -q --allow-empty -m 'ancestry commit'`,
    ].join(" && ");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headSubject(repo), "ancestry commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows a commit on main when the lock's holder is dead", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  try {
    const repo = makeRig(dir);
    writeLock(repo, deadPid());

    // with-merge-lock steals a dead holder's lock rather than honouring it,
    // so a corpse must not wedge every commit on main behind it either.
    const result = commit(repo, "commit past a dead holder");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headSubject(repo), "commit past a dead holder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows a commit on main when the lock carries no readable pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  try {
    const repo = makeRig(dir);
    mkdirSync(join(repo, ".git/substrate-merge.lock"), { recursive: true });

    const result = commit(repo, "commit past a pid-less lock");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headSubject(repo), "commit past a pid-less lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never fires off main, however live the lock's holder is", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    writeLock(repo, holder.pid);
    git(repo, "checkout", "-q", "-b", "sub/topic");

    const result = commit(repo, "lane work under someone else's train");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(headSubject(repo), "lane work under someone else's train");
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with-merge-lock exports the token the guard reads", () => {
  const source = execFileSync("cat", [join(ROOT, "scripts/with-merge-lock.sh")], { encoding: "utf8" });
  assert.match(
    source,
    /export SUBSTRATE_MERGE_LOCK_PID="\$\$"/,
    "the holder's handshake token must be exported before the wrapped command runs",
  );
});

test("the hook installer links the merge-commit hook as well", () => {
  const source = execFileSync("cat", [join(ROOT, "scripts/install-git-hooks.sh")], { encoding: "utf8" });
  assert.match(source, /pre-merge-commit/, "pre-merge-commit must be installed, or the merge path has no guard");
});
