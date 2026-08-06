import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// push-gated-main.sh is the answer to the 2026-08-04 ungated-rider push:
// batch gated green at one sha, another session committed straight onto main
// in the gap, and `git push origin main` shipped that ungated commit because
// the branch NAME resolves at push time.
//
// So the two properties under test are exactly the two hardenings:
//   1. what lands on the remote is the gated COMMIT, byte for byte;
//   2. main having moved since the gate run is a loud abort, not a rider.
//
// Every rig is a real git repo with a real bare remote in a temp dir, so the
// push is a real push and the assertion is against what the remote actually
// received — not against a mock.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

type Rig = { repo: string; remote: string };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRig(dir: string): Rig {
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/push-gated-main.sh"), join(repo, "scripts/push-gated-main.sh"));
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Push Test");
  git(repo, "config", "user.email", "push@example.test");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "initial");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { repo, remote };
}

function commit(rig: Rig, message: string): string {
  git(rig.repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(rig.repo, "rev-parse", "HEAD");
}

function run(rig: Rig, ...args: string[]) {
  return spawnSync("bash", [join(rig.repo, "scripts/push-gated-main.sh"), ...args], {
    cwd: rig.repo,
    encoding: "utf8",
  });
}

// A `git` wrapper first on PATH that records every argv the script uses and
// then execs the real git. It is the only way to see WHAT was pushed rather
// than what the remote happens to hold afterwards — the remote state alone
// cannot tell a sha refspec from a branch-name one.
function installGitShim(dir: string): { bin: string; pushArgs: () => string[] } {
  const bin = join(dir, "shim");
  const log = join(dir, "git-argv.log");
  mkdirSync(bin, { recursive: true });
  const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    pushArgs: () =>
      (existsSync(log) ? readFileSync(log, "utf8") : "")
        .split("\n")
        .filter((line) => /(^| )push( |$)/.test(line)),
  };
}

function runWithShim(rig: Rig, shimBin: string, ...args: string[]) {
  return spawnSync("bash", [join(rig.repo, "scripts/push-gated-main.sh"), ...args], {
    cwd: rig.repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimBin}:${process.env.PATH ?? ""}` },
  });
}

const remoteMain = (rig: Rig) => git(rig.remote, "rev-parse", "refs/heads/main");

/* ---------------------------------------------------------------------- *
 * Hardening 1 — the pushed sha IS the gated sha.
 * ---------------------------------------------------------------------- */

test("pushes the gated sha to main", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const gated = commit(rig, "merged sub/foo");

    const res = run(rig, gated);

    assert.equal(res.status, 0, res.stderr);
    assert.equal(remoteMain(rig), gated, "the remote must hold exactly the gated commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the push refspec names the gated commit, never a branch name", () => {
  // This is the one property the remote's post-push state cannot prove: with
  // local main sitting on the gated sha (which it must, or the script aborts
  // first), `main:refs/heads/main` and `<sha>:refs/heads/main` leave the
  // remote in identical states. So assert on the argv actually handed to git.
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const shim = installGitShim(dir);
    const gated = commit(rig, "merged sub/foo");

    const res = runWithShim(rig, shim.bin, gated);

    assert.equal(res.status, 0, res.stderr);
    const pushes = shim.pushArgs();
    assert.equal(pushes.length, 1, `expected exactly one push, got: ${JSON.stringify(pushes)}`);
    assert.equal(
      pushes[0],
      `push origin ${gated}:refs/heads/main`,
      "the refspec must name the gated sha, not a name that re-resolves at push time",
    );
    assert.equal(remoteMain(rig), gated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a commit landing on main during the push does not reach the remote", () => {
  // End-to-end corroboration, not the discriminating case: a pre-push hook
  // advances refs/heads/main while the push runs, and the remote still ends
  // up holding exactly the gated commit. (git resolves a refspec's source
  // before it runs the hook, so a branch-name refspec would survive this too
  // — the test above is the one that fails if the spelling regresses.)
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const gated = commit(rig, "merged sub/foo");

    writeFileSync(
      join(rig.repo, ".git/hooks/pre-push"),
      "#!/usr/bin/env bash\ngit commit -q --allow-empty -m 'ungated rider' >/dev/null 2>&1\nexit 0\n",
      { mode: 0o755 },
    );

    const res = run(rig, gated);

    assert.equal(res.status, 0, res.stderr);
    assert.notEqual(
      git(rig.repo, "rev-parse", "refs/heads/main"),
      gated,
      "the hook must actually have moved local main",
    );
    assert.equal(remoteMain(rig), gated, "the remote must hold the gated commit, not the rider");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second run against an already-pushed sha is a quiet no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const gated = commit(rig, "merged sub/foo");
    assert.equal(run(rig, gated).status, 0);
    git(rig.repo, "fetch", "-q", "origin");

    const res = run(rig, gated);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to push/);
    assert.equal(remoteMain(rig), gated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------- *
 * Hardening 1b — main moved => loud abort, nothing ships.
 * ---------------------------------------------------------------------- */

test("aborts and ships nothing when a commit landed on main after the gate run", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const before = remoteMain(rig);
    const gated = commit(rig, "merged sub/foo");
    // The B12 case: another session commits docs straight onto main.
    commit(rig, "docs: friction sweep");

    const res = run(rig, gated);

    assert.equal(res.status, 1, "a rider on main must be a hard failure");
    assert.match(res.stderr, /UNGATED COMMITS ON main/);
    assert.match(res.stderr, /REFUSING TO PUSH/);
    assert.match(res.stderr, /docs: friction sweep/, "the abort must name the rider commit");
    assert.match(res.stderr, /1 commit\(s\) landed on main AFTER the gate run/);
    assert.equal(remoteMain(rig), before, "nothing may reach the remote on abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborts when main was reset behind the gated sha", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const before = remoteMain(rig);
    const gated = commit(rig, "merged sub/foo");
    git(rig.repo, "reset", "-q", "--hard", "HEAD~1");

    const res = run(rig, gated);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /main is BEHIND the gated sha/);
    assert.equal(remoteMain(rig), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborts when main diverged from the gated sha", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const before = remoteMain(rig);
    const gated = commit(rig, "merged sub/foo");
    git(rig.repo, "reset", "-q", "--hard", "HEAD~1");
    commit(rig, "rewritten history");

    const res = run(rig, gated);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /DIVERGED/);
    assert.equal(remoteMain(rig), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------- *
 * Refusals that keep the caller honest.
 * ---------------------------------------------------------------------- */

test("refuses a moving name instead of a gated commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const before = remoteMain(rig);
    commit(rig, "merged sub/foo");

    for (const moving of ["main", "HEAD", "refs/heads/main", "@"]) {
      const res = run(rig, moving);
      assert.equal(res.status, 1, `${moving} must be refused`);
      assert.match(res.stderr, /moving name, not a gated commit/);
    }
    assert.equal(remoteMain(rig), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses spellings that only look different from the branch name", () => {
  // Each of these resolves to the branch tip, so a refusal keyed on the
  // literal string "main" waves them through and the rider check below then
  // compares main against itself — the abort can never fire.
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const before = remoteMain(rig);
    commit(rig, "merged sub/foo");

    for (const alias of ["heads/main", "main@{0}", "main^{0}", "refs/heads/main^{commit}"]) {
      const res = run(rig, alias);
      assert.equal(res.status, 1, `${alias} must be refused`);
      assert.match(res.stderr, /moving name, not a gated commit/);
    }
    assert.equal(remoteMain(rig), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a --remote value that is empty or flag-shaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const gated = commit(rig, "merged sub/foo");

    const empty = run(rig, "--remote=", gated);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /--remote needs a non-empty value/);

    const flag = run(rig, "--remote", "--help", gated);
    assert.equal(flag.status, 1);
    assert.match(flag.stderr, /looks like an option, not a remote/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale tracking ref does not fake a no-op", () => {
  // refs/remotes/origin/main is a local cache. Point it at the gated sha
  // while the remote sits elsewhere: trusting the cache would print "nothing
  // to push" and exit 0 for a commit that never shipped.
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const gated = commit(rig, "merged sub/foo");
    git(rig.repo, "update-ref", "refs/remotes/origin/main", gated);

    const res = run(rig, gated);

    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /nothing to push/);
    assert.equal(remoteMain(rig), gated, "the gated commit must actually reach the remote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a sha this repository does not have", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const res = run(rig, "0".repeat(40));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /is not a commit in this repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses when no gated sha is given at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    const res = run(rig);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /exactly one gated sha is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-fast-forward remote is a failure, never a force", () => {
  const dir = mkdtempSync(join(tmpdir(), "substrate-push-gated-"));
  try {
    const rig = makeRig(dir);
    // The remote advances independently — the gated sha no longer fast-forwards.
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", rig.remote, other], { encoding: "utf8" });
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.test");
    git(other, "commit", "-q", "--allow-empty", "-m", "remote moved");
    git(other, "push", "-q", "origin", "main");
    const remoteTip = remoteMain(rig);

    const gated = commit(rig, "merged sub/foo");
    const res = run(rig, gated);

    assert.equal(res.status, 1);
    // The exit code must be git's own, not the status of the enclosing test —
    // the diagnostic is read under pressure and "exit 0" would be a lie.
    assert.match(res.stderr, /push failed \(exit 1\)\./);
    assert.equal(remoteMain(rig), remoteTip, "the remote's history must be untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
