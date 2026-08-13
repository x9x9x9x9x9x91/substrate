import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// lane-prepush.sh moves two checks that already existed — eslint and the
// comment-vocabulary gate — from the far end of a 40-minute rig suite to the
// moment a lane parks. So what is worth pinning is not that the checks work
// (they have their own tests) but the plumbing around them:
//
//   1. WHICH files eslint is handed. A three-dot diff, deletions dropped,
//      non-JS/TS paths dropped. Hand it the wrong list and the check is
//      either useless (empty) or a tree-wide lint whose backlog of warnings
//      buries the one new error.
//   2. That the second check runs even when the first failed, and that either
//      failure alone is a nonzero exit.
//
// Both legs are stubbed by shims first on PATH, which record their argv. That
// keeps the rig a plain git repo with no node_modules: a real `npx eslint`
// here would resolve up into the checkout's install and lint the wrong tree.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

interface Rig {
  repo: string;
  bin: string;
}

/** A recording stub for `name` that exits `code` and logs its argv, one per line. */
function shim(rig: Rig, name: string, code: number): void {
  const log = join(rig.bin, `${name}.log`);
  writeFileSync(
    join(rig.bin, name),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit ${code}\n`,
  );
  chmodSync(join(rig.bin, name), 0o755);
}

function argvOf(rig: Rig, name: string): string[] {
  try {
    return readFileSync(join(rig.bin, `${name}.log`), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function makeRig(dir: string): Rig {
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(join(ROOT, "scripts/lane-prepush.sh"), join(repo, "scripts/lane-prepush.sh"));
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));

  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Prepush Test");
  git(repo, "config", "user.email", "prepush@example.test");
  writeFileSync(join(repo, "base.ts"), "export const base = 1;\n");
  writeFileSync(join(repo, "doomed.ts"), "export const doomed = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "initial");
  // Stands in for origin/main: the script only ever resolves the base as a ref.
  git(repo, "branch", "base-ref");

  const rig: Rig = { repo, bin };
  shim(rig, "npx", 0);
  shim(rig, "node", 0);
  return rig;
}

function run(rig: Rig, ...args: string[]) {
  return spawnSync("bash", [join(rig.repo, "scripts/lane-prepush.sh"), "--base", "base-ref", ...args], {
    cwd: rig.repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${rig.bin}:${process.env.PATH}` },
  });
}

function withRig(fn: (rig: Rig) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lane-prepush-"));
  try {
    fn(makeRig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("eslint gets this branch's changed JS/TS files, and nothing else", () => {
  withRig((rig) => {
    writeFileSync(join(rig.repo, "added.tsx"), "export const added = 1;\n");
    writeFileSync(join(rig.repo, "base.ts"), "export const base = 2;\n");
    writeFileSync(join(rig.repo, "notes.md"), "prose\n");
    rmSync(join(rig.repo, "doomed.ts"));
    git(rig.repo, "add", "-A");
    git(rig.repo, "commit", "-qm", "changes");

    const res = run(rig);
    assert.equal(res.status, 0, res.stderr);

    const argv = argvOf(rig, "npx");
    assert.equal(argv[0], "eslint");
    const files = argv.filter((a) => !a.startsWith("-") && a !== "eslint");
    assert.deepEqual(files.sort(), ["added.tsx", "base.ts"]);
    assert.ok(!files.includes("doomed.ts"), "a deleted file is not linted");
    assert.ok(!files.includes("notes.md"), "prose is not eslint's business");
  });
});

test("a base-only change is not this branch's business", () => {
  withRig((rig) => {
    // Main moved under the branch; the branch itself changed nothing.
    git(rig.repo, "checkout", "-q", "base-ref");
    writeFileSync(join(rig.repo, "theirs.ts"), "export const theirs = 1;\n");
    git(rig.repo, "add", "-A");
    git(rig.repo, "commit", "-qm", "their change");
    git(rig.repo, "checkout", "-q", "main");

    const res = run(rig);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no changed JS\/TS files/);
    assert.deepEqual(argvOf(rig, "npx"), [], "eslint is not invoked at all");
    assert.ok(argvOf(rig, "node").some((a) => a.includes("check-comment-vocab")));
  });
});

test("the vocabulary check runs even after eslint fails, and the run exits nonzero", () => {
  withRig((rig) => {
    shim(rig, "npx", 1);
    writeFileSync(join(rig.repo, "added.ts"), "export const added = 1;\n");
    git(rig.repo, "add", "-A");
    git(rig.repo, "commit", "-qm", "changes");

    const res = run(rig);
    assert.equal(res.status, 1);
    assert.ok(
      argvOf(rig, "node").some((a) => a.includes("check-comment-vocab")),
      "a lane fixing one fault should see both, not discover the second next pass",
    );
    assert.match(res.stderr, /FAILED/);
  });
});

test("a vocabulary hit alone fails the run", () => {
  withRig((rig) => {
    shim(rig, "node", 1);
    const res = run(rig);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /FAILED/);
  });
});

test("an unresolvable base is refused rather than silently linting nothing", () => {
  withRig((rig) => {
    const res = spawnSync(
      "bash",
      [join(rig.repo, "scripts/lane-prepush.sh"), "--base", "origin/nope"],
      { cwd: rig.repo, encoding: "utf8", env: { ...process.env, PATH: `${rig.bin}:${process.env.PATH}` } },
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no such base ref/);
    assert.deepEqual(argvOf(rig, "npx"), []);
  });
});
