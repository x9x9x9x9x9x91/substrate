import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// checkout-guard.sh: scripts/ entry points must refuse to run out
// of a checkout that is detached BEHIND origin/main — that is the primary
// checkout's permanent shape, and invoking tooling through it silently runs
// old code. The guard reads the tree the guard FILE lives in, never the
// caller's cwd, because that is the tree whose code is executing.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Rig = { repo: string; older: string; newer: string };

/** A repo on branch `main` with two commits and origin/main at the tip. */
function makeRig(dir: string): Rig {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));

  const tool = join(repo, "scripts/tool.sh");
  writeFileSync(
    tool,
    `#!/usr/bin/env bash\nset -euo pipefail\n. "$(cd "$(dirname "$0")" && pwd)/lib/checkout-guard.sh"\nguard_checkout_freshness tool.sh\necho RAN\n`,
  );
  chmodSync(tool, 0o755);

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Guard Test");
  git("config", "user.email", "guard@example.test");
  git("add", "-A");
  git("commit", "-qm", "tooling");
  const older = git("rev-parse", "HEAD").trim();
  git("commit", "-qm", "later work", "--allow-empty");
  const newer = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", newer);
  return { repo, older, newer };
}

function run(rig: Rig, env: Record<string, string> = {}) {
  return spawnSync("bash", [join(rig.repo, "scripts/tool.sh")], {
    cwd: rig.repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function withRig(fn: (rig: Rig) => void) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-guard-"));
  try {
    fn(makeRig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a checkout on a branch runs — lanes are behind main all the time", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "-b", "sub/lane", rig.older]);
    const r = run(rig);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RAN/);
    assert.equal(r.stderr, "");
  });
});

test("detached exactly at origin/main runs silently", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "--detach", rig.newer]);
    const r = run(rig);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RAN/);
    assert.equal(r.stderr, "");
  });
});

test("detached BEHIND origin/main refuses, naming both SHAs (SUB-509)", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "--detach", rig.older]);
    const r = run(rig);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /RAN/); // the tool's own body never started
    assert.match(r.stderr, /tool\.sh: refusing to run/);
    assert.match(r.stderr, new RegExp(rig.older.slice(0, 7)));
    assert.match(r.stderr, new RegExp(rig.newer.slice(0, 7)));
    assert.match(r.stderr, /SUB-509/);
    assert.match(r.stderr, /Fresh clone\? Bootstrap/);
    assert.match(r.stderr, /git checkout main/);
    assert.doesNotMatch(r.stderr, /\.worktrees\/_main/);
  });
});

test("a stale primary names the existing main worktree", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "--detach", rig.older]);
    const mainTree = join(rig.repo, "main-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", mainTree, "main"]);
    const r = run(rig);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cd .*main-tree && bash scripts\/tool\.sh/);
    assert.doesNotMatch(r.stderr, /Fresh clone\? Bootstrap/);
  });
});

test("the refusal is overridable for deliberate old-tooling runs", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "--detach", rig.older]);
    const r = run(rig, { SUBSTRATE_ALLOW_STALE_SCRIPTS: "1" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RAN/);
  });
});

test("detached off main's line warns but still runs — not stale, just elsewhere", () => {
  withRig((rig) => {
    const git = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" });
    git("checkout", "-q", "--detach", rig.older);
    git("commit", "-qm", "sidetrack", "--allow-empty");
    const r = run(rig);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RAN/);
    assert.match(r.stderr, /WARNING: running from a detached checkout/);
  });
});

test("outside a git repo the guard stays out of the way", () => {
  withRig((rig) => {
    rmSync(join(rig.repo, ".git"), { recursive: true, force: true });
    const r = run(rig);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RAN/);
  });
});

test("no origin/main ref (a fresh clone-less repo) is not an error", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "update-ref", "-d", "refs/remotes/origin/main"]);
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "--detach", rig.older]);
    const r = run(rig);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RAN/);
  });
});

test("every executable entry point in scripts/ is guarded", () => {
  // A new script that forgets the guard is exactly how this defect returns.
  const entries = [
    "autosync-verify.sh",
    "with-merge-lock.sh",
    "push-gated-main.sh",
    "branch-gates.sh",
    "lane-prepush.sh",
    "merge-queue.sh",
    "train-preflight.sh",
    "install-git-hooks.sh",
    "prepare-mcp-sidecar.sh",
    "verify-gates.sh",
    "verify-quarantine.sh",
  ];
  // Exempt ON PURPOSE, and asserted to STAY exempt so the exemption cannot rot
  // into an oversight: a script here must not call the guard, and must say why.
  const exempt: Array<[string, string]> = [
  ];
  for (const name of entries) {
    const body = execFileSync("cat", [join(ROOT, "scripts", name)], { encoding: "utf8" });
    assert.match(body, /guard_checkout_freshness/, `${name} does not call the checkout guard`);
  }
  for (const [name, why] of exempt) {
    const body = execFileSync("cat", [join(ROOT, "scripts", name)], { encoding: "utf8" });
    assert.doesNotMatch(body, /guard_checkout_freshness/, `${name} is listed exempt (${why}) but calls the guard — pick one`);
  }
  const listed = execFileSync("ls", [join(ROOT, "scripts")], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sh"));
  const accounted = [...entries, ...exempt.map(([name]) => name)];
  assert.deepEqual(listed.sort(), accounted.sort(), "a scripts/*.sh entry point appeared or vanished — guard it too");
});
