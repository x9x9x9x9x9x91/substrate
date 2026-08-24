import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// Every hook install-git-hooks.sh puts into .git/hooks. Kept here rather than
// inline so the installer test asserts the whole set and not just the two the
// merge-lock rigs happen to need.
const INSTALLED_HOOKS = ["post-checkout", "pre-commit", "pre-merge-commit"];

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

test("the override hint is offered on the commit path", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    writeLock(repo, holder.pid);

    const result = commit(repo, "rider straight onto main");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SUBSTRATE_ALLOW_FOREIGN_MERGE_LOCK=1/);
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused reset is not offered the override hint", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    writeLock(repo, holder.pid);

    // Forcing a commit is a call a session can reasonably make; forcing this
    // is a hard reset of local main under someone else's live train, so the
    // refusal must not read as though it comes with a sanctioned escape.
    const result = spawnSync(
      "bash",
      ["-c", ". scripts/git-hooks/lib/merge-lock-guard.sh && merge_lock_guard reset"],
      { cwd: repo, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, "the reset should have been refused");
    assert.match(result.stderr, /refusing reset on main/);
    assert.doesNotMatch(result.stderr, /SUBSTRATE_ALLOW_FOREIGN_MERGE_LOCK/);
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the override variable still lets a deliberate commit through", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  const holder = liveForeignHolder();
  try {
    const repo = makeRig(dir);
    writeLock(repo, holder.pid);

    const result = commit(repo, "deliberate rider", { SUBSTRATE_ALLOW_FOREIGN_MERGE_LOCK: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /override was set/);
    assert.equal(headSubject(repo), "deliberate rider");
  } finally {
    holder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the merge-commit hook refuses a merge on a detached HEAD in the primary checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-guard-"));
  try {
    const repo = makeRig(dir);
    git(repo, "checkout", "-q", "-b", "sub/topic");
    git(repo, "commit", "-q", "--allow-empty", "-m", "topic work");
    git(repo, "checkout", "-q", "main");
    const before = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--detach");

    // No merge lock anywhere: what is under test is the OTHER half of the
    // pre-commit hook, which `git merge --no-ff` never reaches.
    const merged = spawnSync("git", ["-C", repo, "merge", "--no-ff", "-m", "merge topic", "sub/topic"], {
      encoding: "utf8",
    });
    assert.notEqual(merged.status, 0, "the merge commit should have been refused");
    assert.match(merged.stderr, /refusing commit on detached HEAD/);
    assert.equal(git(repo, "rev-parse", "HEAD"), before, "HEAD must not have moved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with-merge-lock exports the token the guard reads, naming the pid its lock file names", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-lock-token-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "scripts/lib"), { recursive: true });
    cpSync(join(ROOT, "scripts/with-merge-lock.sh"), join(repo, "scripts/with-merge-lock.sh"));
    cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Lock Test");
    git(repo, "config", "user.email", "lock@example.test");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "initial");

    // The wrapped command reports the token it inherited and the pid the lock
    // file carries WHILE the lock is held. The guard's whole holder handshake
    // is those two being the same number, so that is what is asserted — not
    // the line of shell that happens to produce it today.
    const result = spawnSync(
      "bash",
      [
        join(repo, "scripts/with-merge-lock.sh"),
        "bash",
        "-c",
        'printf "token=%s lockpid=%s\\n" "$SUBSTRATE_MERGE_LOCK_PID" "$(cat .git/substrate-merge.lock/pid)"',
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const seen = /token=(\d+) lockpid=(\d+)/.exec(result.stdout);
    assert.ok(seen, `expected a token/lockpid line, got: ${result.stdout}`);
    assert.equal(
      seen[1],
      seen[2],
      "the exported token must name the pid the lock file names, or the holder's own commits get refused",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook installer installs every hook, merge-commit half included", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-hook-install-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "scripts/lib"), { recursive: true });
    mkdirSync(join(repo, "scripts/git-hooks/lib"), { recursive: true });
    cpSync(join(ROOT, "scripts/install-git-hooks.sh"), join(repo, "scripts/install-git-hooks.sh"));
    cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));
    for (const hook of INSTALLED_HOOKS) {
      cpSync(join(ROOT, "scripts/git-hooks", hook), join(repo, "scripts/git-hooks", hook));
    }
    cpSync(
      join(ROOT, "scripts/git-hooks/lib/merge-lock-guard.sh"),
      join(repo, "scripts/git-hooks/lib/merge-lock-guard.sh"),
    );
    git(repo, "init", "-q", "-b", "main");

    // Nothing is linked yet — so what the assertions below see on disk is the
    // installer's own doing and not the rig's.
    for (const hook of INSTALLED_HOOKS) {
      assert.equal(existsSync(join(repo, ".git/hooks", hook)), false, `${hook} must start uninstalled`);
    }

    const result = spawnSync("bash", [join(repo, "scripts/install-git-hooks.sh")], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    for (const hook of INSTALLED_HOOKS) {
      const installed = join(repo, ".git/hooks", hook);
      // existsSync follows the link, so a dangling symlink fails here too.
      assert.equal(existsSync(installed), true, `${hook} was not installed`);
      assert.equal(
        realpathSync(installed),
        realpathSync(join(repo, "scripts/git-hooks", hook)),
        `${hook} must resolve to the tree's copy of the hook`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
