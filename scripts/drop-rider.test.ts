import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// drop-rider.sh is the only sanctioned `git reset --hard` on local main: the
// recovery for a train that push-gated-main.sh refused because someone
// committed onto main above the gated sha. A hard reset is exactly the shape
// of command that must not be trusted to a hand-typed argument, so what is
// under test is the guard set — each refusal, by name — and that the happy
// path drops precisely the riders and nothing else.
//
// Every rig is a real git repo with a real bare remote, so "origin/main" in
// the guards is a real published tip and not a fixture ref.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

type Rig = { repo: string; remote: string; gated: string };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// A repo whose local main carries two riders above the sha origin published.
function makeRig(dir: string): Rig {
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  mkdirSync(join(repo, "scripts/git-hooks/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/drop-rider.sh"), join(repo, "scripts/drop-rider.sh"));
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));
  cpSync(
    join(ROOT, "scripts/git-hooks/lib/merge-lock-guard.sh"),
    join(repo, "scripts/git-hooks/lib/merge-lock-guard.sh"),
  );

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Rider Test");
  git(repo, "config", "user.email", "rider@example.test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "initial");
  git(repo, "commit", "-q", "--allow-empty", "-m", "merge sub/gated");
  const gated = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "rider one");
  git(repo, "commit", "-q", "--allow-empty", "-m", "rider two");
  return { repo, remote, gated };
}

function run(rig: Rig, ...args: string[]) {
  return spawnSync("bash", [join(rig.repo, "scripts/drop-rider.sh"), ...args], {
    cwd: rig.repo,
    encoding: "utf8",
  });
}

function withRig(body: (rig: Rig) => void) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-drop-rider-"));
  try {
    body(makeRig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const head = (rig: Rig) => git(rig.repo, "rev-parse", "HEAD");
const subjects = (rig: Rig) => git(rig.repo, "log", "--format=%s").split("\n");

/* ---------------------------------------------------------------------- *
 * Guard (d) — branch main, attached.
 * ---------------------------------------------------------------------- */

test("guard (d): refuses on a detached HEAD", () => {
  withRig((rig) => {
    const before = head(rig);
    git(rig.repo, "checkout", "-q", "--detach");
    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(d\) failed: HEAD is detached/);
    assert.equal(git(rig.repo, "rev-parse", "refs/heads/main"), before, "main must not have moved");
  });
});

test("guard (d): refuses on a feature branch", () => {
  withRig((rig) => {
    git(rig.repo, "checkout", "-q", "-b", "sub/topic");
    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(d\) failed: on branch 'sub\/topic'/);
  });
});

/* ---------------------------------------------------------------------- *
 * Guard (a) — the target resolves, and is at or below local main.
 * ---------------------------------------------------------------------- */

test("guard (a): refuses a sha that names nothing here", () => {
  withRig((rig) => {
    const before = head(rig);
    const result = run(rig, "deadbeefdeadbeef");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(a\) failed: 'deadbeefdeadbeef' is not a commit/);
    assert.equal(head(rig), before);
  });
});

test("guard (a): refuses a commit that is not an ancestor of local main", () => {
  withRig((rig) => {
    const before = head(rig);
    git(rig.repo, "checkout", "-q", "-b", "sub/side", rig.gated);
    git(rig.repo, "commit", "-q", "--allow-empty", "-m", "off to the side");
    const side = git(rig.repo, "rev-parse", "HEAD");
    git(rig.repo, "checkout", "-q", "main");

    const result = run(rig, side);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(a\) failed:.*is not an ancestor of local main/);
    assert.equal(head(rig), before);
  });
});

/* ---------------------------------------------------------------------- *
 * Guard (c) — clean worktree, no parked merge.
 * ---------------------------------------------------------------------- */

test("guard (c): refuses with uncommitted changes in the worktree", () => {
  withRig((rig) => {
    const before = head(rig);
    writeFileSync(join(rig.repo, "file.txt"), "edited but never committed\n");
    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(c\) failed: the worktree has uncommitted changes/);
    assert.match(result.stderr, /file\.txt/);
    assert.equal(head(rig), before);
    assert.match(
      execFileSync("cat", [join(rig.repo, "file.txt")], { encoding: "utf8" }),
      /never committed/,
      "the edit must survive the refusal",
    );
  });
});

test("guard (c): refuses with an unfinished merge parked in the tree", () => {
  withRig((rig) => {
    git(rig.repo, "checkout", "-q", "-b", "sub/conflict", rig.gated);
    writeFileSync(join(rig.repo, "file.txt"), "theirs\n");
    git(rig.repo, "commit", "-qam", "conflicting change");
    git(rig.repo, "checkout", "-q", "main");
    writeFileSync(join(rig.repo, "file.txt"), "ours\n");
    git(rig.repo, "commit", "-qam", "our change");
    const before = head(rig);
    spawnSync("git", ["-C", rig.repo, "merge", "--no-commit", "sub/conflict"], { encoding: "utf8" });

    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(c\) failed: an unfinished merge \(MERGE_HEAD\)/);
    assert.equal(head(rig), before);
  });
});

/* ---------------------------------------------------------------------- *
 * --remote takes a configured remote NAME, never a URL.
 * ---------------------------------------------------------------------- */

test("--remote refuses a raw URL", () => {
  withRig((rig) => {
    const before = head(rig);
    // git itself would accept a URL here, and the published-tip comparison
    // would then run against whatever repository the caller named instead of
    // where main actually publishes.
    for (const form of [["--remote", rig.remote], [`--remote=${rig.remote}`]]) {
      const result = run(rig, ...form, rig.gated);
      assert.notEqual(result.status, 0, `${form.join(" ")} should have been refused`);
      assert.match(result.stderr, /is not a configured remote of this repository/);
    }
    assert.equal(git(rig.repo, "rev-parse", "refs/heads/main"), before, "main must not have moved");
  });
});

/* ---------------------------------------------------------------------- *
 * Guard (b) — at or above what origin publishes, asked fresh.
 * ---------------------------------------------------------------------- */

test("guard (b): refuses a target below origin/main", () => {
  withRig((rig) => {
    const before = head(rig);
    const belowPublished = git(rig.repo, "rev-parse", `${rig.gated}^`);
    const result = run(rig, belowPublished);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(b\) failed:.*is not at or above origin\/main/);
    assert.equal(head(rig), before);
  });
});

test("guard (b): refuses when origin cannot be reached", () => {
  withRig((rig) => {
    const before = head(rig);
    git(rig.repo, "remote", "set-url", "origin", join(rig.repo, "..", "gone.git"));
    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(b\) failed: could not fetch origin main/);
    assert.equal(head(rig), before);
  });
});

test("guard (b): re-reads origin, so a main that moved under the recovery is honoured", () => {
  withRig((rig) => {
    // origin advances to a commit the local tracking ref has never seen: the
    // once-valid gated sha is now BELOW published history.
    const other = join(rig.repo, "..", "other");
    execFileSync("git", ["clone", "-q", rig.remote, other], { encoding: "utf8" });
    git(other, "config", "user.name", "Other Session");
    git(other, "config", "user.email", "other@example.test");
    git(other, "commit", "-q", "--allow-empty", "-m", "landed while we deliberated");
    git(other, "push", "-q", "origin", "main");

    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guard \(b\) failed:.*is not at or above origin\/main/);
  });
});

/* ---------------------------------------------------------------------- *
 * The reset itself.
 * ---------------------------------------------------------------------- */

test("drops exactly the riders and lands on the target sha", () => {
  withRig((rig) => {
    const riders = git(rig.repo, "rev-parse", "HEAD");
    const result = run(rig, git(rig.repo, "rev-parse", "--short", rig.gated));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(head(rig), rig.gated, "local main must land on the gated sha");
    assert.deepEqual(subjects(rig), ["merge sub/gated", "initial"]);

    // The riders are named before they go, with the branch that keeps them.
    assert.match(result.stderr, /rider one/);
    assert.match(result.stderr, /rider two/);
    assert.match(result.stdout, /local main is now/);
    assert.equal(
      git(rig.repo, "rev-parse", `${riders}^{commit}`),
      riders,
      "the dropped commits stay reachable by sha until gc",
    );
  });
});

test("the riders are kept on a rescue branch pointing at the pre-reset tip", () => {
  withRig((rig) => {
    const riders = head(rig);
    const result = run(rig, rig.gated);
    assert.equal(result.status, 0, result.stderr);

    // A named ref, not just a reflog entry: this is what makes the tool
    // non-destructive rather than merely recoverable by someone who knows to
    // look in the reflog before gc gets there.
    const rescued = git(rig.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/rescue")
      .split("\n")
      .filter(Boolean);
    assert.equal(rescued.length, 1, `expected exactly one rescue branch, got ${JSON.stringify(rescued)}`);
    assert.match(rescued[0], /^rescue\/riders-\d{8}T\d{6}Z$/);
    assert.equal(git(rig.repo, "rev-parse", rescued[0]), riders, "the rescue branch must hold the old main tip");
    assert.match(result.stderr, new RegExp(rescued[0].replace("/", "\\/")));
    assert.match(result.stdout, new RegExp(rescued[0].replace("/", "\\/")));
  });
});

test("refuses the reset when the rescue branch cannot be created", () => {
  withRig((rig) => {
    const before = head(rig);
    // refs/heads/rescue as a FILE makes every refs/heads/rescue/* branch
    // uncreatable (git cannot nest a ref under an existing one), which is the
    // cheapest true "git branch failed" this side of a read-only .git.
    writeFileSync(join(rig.repo, ".git/refs/heads/rescue"), `${before}\n`);
    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0, "no rescue branch means no reset");
    assert.match(result.stderr, /could not create the rescue branch rescue\/riders-/);
    assert.equal(git(rig.repo, "rev-parse", "refs/heads/main"), before, "main must not have moved");
  });
});

test("says nothing to drop when local main is already at the target", () => {
  withRig((rig) => {
    git(rig.repo, "reset", "-q", "--hard", rig.gated);
    const result = run(rig, rig.gated);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to drop/);
    assert.equal(head(rig), rig.gated);
  });
});

test("an abbreviated target sha resolves", () => {
  withRig((rig) => {
    const result = run(rig, rig.gated.slice(0, 8));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(head(rig), rig.gated);
  });
});

/* ---------------------------------------------------------------------- *
 * Guard (e) — the merge lock.
 * ---------------------------------------------------------------------- */

test("guard (e): refuses while another live process holds the merge lock", () => {
  // Alive for the duration of the test and not an ancestor of the script —
  // a foreign holder mid-train, which is exactly who the guard protects.
  const holder = spawn("sleep", ["120"], { stdio: "ignore" });
  holder.unref();
  try {
    withRig((rig) => {
      const before = head(rig);
      const lock = join(rig.repo, ".git/substrate-merge.lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "pid"), `${holder.pid}\n`);
      const result = run(rig, rig.gated);
      assert.notEqual(result.status, 0, "the reset should have been refused");
      assert.match(result.stderr, /refusing reset on main/);
      assert.equal(git(rig.repo, "rev-parse", "refs/heads/main"), before, "main must not have moved");
    });
  } finally {
    holder.kill("SIGKILL");
  }
});

test("guard (e): runs again after the fetch, not just before it", () => {
  withRig((rig) => {
    // The first call happens before guard (b) fetches, and a fetch is long
    // enough for another session to claim the lock and start a train. So the
    // guard must be asked once more with the reset actually imminent. A stub
    // records each call and whether the fetch had happened by then.
    const log = join(rig.repo, "guard-calls.log");
    writeFileSync(
      join(rig.repo, "scripts/git-hooks/lib/merge-lock-guard.sh"),
      [
        "merge_lock_guard() {",
        `  fetched=no; [ -e "$(git rev-parse --git-dir)/FETCH_HEAD" ] && fetched=yes`,
        `  printf '%s %s\\n' "\${1:-commit}" "$fetched" >> ${JSON.stringify(log)}`,
        "  return 0",
        "}",
        "",
      ].join("\n"),
    );

    const result = run(rig, rig.gated);
    assert.equal(result.status, 0, result.stderr);
    const calls = execFileSync("cat", [log], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(calls, ["reset no", "reset yes"], "the guard must run before AND after the fetch");
  });
});

test("guard (e): a missing guard library refuses rather than falling open", () => {
  withRig((rig) => {
    const before = head(rig);
    rmSync(join(rig.repo, "scripts/git-hooks/lib/merge-lock-guard.sh"));
    const result = run(rig, rig.gated);
    assert.notEqual(result.status, 0, "a checkout without the guard must not reset");
    assert.match(result.stderr, /guard \(e\) failed/);
    assert.equal(git(rig.repo, "rev-parse", "refs/heads/main"), before, "main must not have moved");
  });
});
