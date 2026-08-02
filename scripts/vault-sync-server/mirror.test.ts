import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { findMirrorDivergence, syncMirror } from "./mirror.ts";
import {
  reportMirrorStatus,
  STATUS_DIVERGED,
  STATUS_ERROR,
  STATUS_FRESH,
  STATUS_STALE,
} from "./status.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const mirrorScript = join(here, "mirror.ts");
const statusScript = join(here, "status.ts");

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(script: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** A working vault with one commit, plus the paths a mirror will use. */
async function makeVault(root: string): Promise<{ working: string; mirror: string }> {
  const working = join(root, "working-vault");
  const mirror = join(root, "vault.git");
  await git(["init", "-q", "-b", "main", working]);
  await git(["-C", working, "config", "user.name", "Substrate Test"]);
  await git(["-C", working, "config", "user.email", "test@substrate.invalid"]);
  await writeFile(join(working, "vault-note.md"), "first version\n");
  await git(["-C", working, "add", "vault-note.md"]);
  await git(["-C", working, "commit", "-q", "-m", "first vault commit"]);
  return { working, mirror };
}

/** Commit straight into the bare mirror — what a phone push leaves behind. */
async function commitInMirror(mirror: string, message: string, branch = "main"): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "substrate-phone-clone-"));
  const clone = join(scratch, "clone");
  await git(["clone", "-q", mirror, clone]);
  await git(["-C", clone, "config", "user.name", "Phone Test"]);
  await git(["-C", clone, "config", "user.email", "phone@substrate.invalid"]);
  await writeFile(join(clone, "phone-note.md"), `${message}\n`);
  await git(["-C", clone, "add", "phone-note.md"]);
  await git(["-C", clone, "commit", "-q", "-m", message]);
  await git(["-C", clone, "push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  const tip = await git(["-C", clone, "rev-parse", "HEAD"]);
  await rm(scratch, { recursive: true, force: true });
  return tip;
}

/**
 * Rewrite the vault's history the way Substrate's purge path does: replay a
 * filtered history onto a new root, reset the branch, then drop every way back
 * to the old commits (reflog + gc), so they become unreachable from the source.
 */
async function rewriteHistory(working: string, message: string): Promise<string> {
  const tree = await git(["-C", working, "rev-parse", "HEAD^{tree}"]);
  const replayed = await git(["-C", working, "commit-tree", tree, "-m", message]);
  await git(["-C", working, "reset", "-q", "--hard", replayed]);
  await git(["-C", working, "reflog", "expire", "--expire=now", "--all"]);
  await git(["-C", working, "gc", "-q", "--prune=now"]);
  return replayed;
}

async function withRoot(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "substrate-vault-mirror-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("refresh refuses to clobber mirror-only commits, and --force overrides", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  assert.equal(await syncMirror({ source: working, mirror }), "created");

  const phoneTip = await commitInMirror(mirror, "phone commit");
  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);

  const divergences = await findMirrorDivergence(working, mirror);
  assert.deepEqual(divergences, [{ branch: "main", pending: 1, deletedUpstream: false }]);

  await assert.rejects(
    syncMirror({ source: working, mirror }),
    /refusing to refresh.*main \(1 commit\)/s,
  );
  // Refusing must leave the phone commit in place.
  assert.equal(await git(["--git-dir", mirror, "rev-parse", "refs/heads/main"]), phoneTip);

  const refused = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /refusing to refresh/);
  assert.match(refused.stderr, /main \(1 commit\)/);
  assert.match(refused.stderr, /pull --ff-only vault-sync main/);

  assert.equal(await syncMirror({ source: working, mirror, force: true }), "refreshed");
  assert.equal(
    await git(["--git-dir", mirror, "rev-parse", "refs/heads/main"]),
    await git(["-C", working, "rev-parse", "main"]),
  );
});

test("a branch the Mac published then deleted is pruned, a phone-only branch is not", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await git(["-C", working, "checkout", "-q", "-b", "mac-scratch"]);
  await writeFile(join(working, "scratch.md"), "scratch\n");
  await git(["-C", working, "add", "scratch.md"]);
  await git(["-C", working, "commit", "-q", "-m", "scratch commit"]);
  await git(["-C", working, "checkout", "-q", "main"]);
  assert.equal(await syncMirror({ source: working, mirror }), "created");

  // The Mac published this branch, so the last-refresh markers cover its tip:
  // deleting it upstream is Mac-side history management, not lost phone work.
  await git(["-C", working, "branch", "-q", "-D", "mac-scratch"]);
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");
  assert.equal(await git(["--git-dir", mirror, "for-each-ref", "refs/heads/mac-scratch"]), "");

  // A branch that only ever existed in the mirror is unaccounted for and still
  // blocks the refresh, because a prune would be the only record of it.
  await commitInMirror(mirror, "phone branch commit", "phone-only");
  const divergences = await findMirrorDivergence(working, mirror);
  assert.deepEqual(divergences, [{ branch: "phone-only", pending: 1, deletedUpstream: true }]);
  await assert.rejects(
    syncMirror({ source: working, mirror }),
    /phone-only \(1 commit, branch missing from the working vault\)/,
  );

  assert.equal(await syncMirror({ source: working, mirror, force: true }), "refreshed");
  assert.equal(await git(["--git-dir", mirror, "for-each-ref", "refs/heads/phone-only"]), "");
});

test("guard passes on a fast-forward and on a merged phone commit", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  assert.equal(await syncMirror({ source: working, mirror }), "created");

  // Mac-only new commits: pure fast-forward, no divergence.
  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");

  // Once the phone commit is pulled into the working vault the guard clears.
  await commitInMirror(mirror, "phone commit");
  assert.equal((await findMirrorDivergence(working, mirror)).length, 1);
  await git(["-C", working, "remote", "add", "vault-sync", mirror]);
  await git(["-C", working, "pull", "-q", "--ff-only", "vault-sync", "main"]);
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  assert.equal(await syncMirror({ source: working, mirror }), "fresh");
});

test("a source history rewrite refreshes on its own, without --force", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);
  assert.equal(await syncMirror({ source: working, mirror }), "created");
  const beforeRewrite = await git(["--git-dir", mirror, "rev-parse", "refs/heads/main"]);

  // What TrashPane's empty-trash / HistoryPanel's purge leaves behind: every
  // commit the mirror holds is now unreachable from the working vault.
  const rewritten = await rewriteHistory(working, "purged history");
  assert.notEqual(rewritten, beforeRewrite);
  assert.equal(
    await git(["-C", working, "rev-list", "--count", "main", `^${rewritten}`]),
    "0",
  );

  // The markers account for the superseded commits, so the guard stays quiet
  // and the interval job self-heals.
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  const cli = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  assert.equal(cli.code, 0);
  assert.equal(cli.stderr, "");
  assert.equal(await git(["--git-dir", mirror, "rev-parse", "refs/heads/main"]), rewritten);

  const status = await run(statusScript, ["--source", working, "--mirror", mirror]);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /^fresh: /);

  // A plain amend is the same shape and must also pass.
  await writeFile(join(working, "vault-note.md"), "amended version\n");
  await git(["-C", working, "commit", "-q", "-a", "--amend", "-m", "amended"]);
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");
});

test("a rewrite plus a phone push still refuses", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  assert.equal(await syncMirror({ source: working, mirror }), "created");

  const phoneTip = await commitInMirror(mirror, "phone commit");
  await rewriteHistory(working, "purged history");

  // The phone commit sits ahead of the markers, so it is not accounted for even
  // though the rest of the mirror's history now is.
  const divergences = await findMirrorDivergence(working, mirror);
  assert.deepEqual(divergences, [{ branch: "main", pending: 1, deletedUpstream: false }]);
  const refused = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /main \(1 commit\)/);
  assert.equal(await git(["--git-dir", mirror, "rev-parse", "refs/heads/main"]), phoneTip);
});

test("refusal names both remedies: pull, or --force with its warning", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await syncMirror({ source: working, mirror });
  await commitInMirror(mirror, "phone commit");

  const refused = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /pull --ff-only vault-sync main/);
  assert.match(refused.stderr, /refresh with --force/);
  assert.match(refused.stderr, /--force discards them permanently/);
  // Markers exist here, so the pre-marker fallback note must not appear.
  assert.doesNotMatch(refused.stderr, /no last-refresh markers/);
});

test("a mirror without markers keeps the strict behaviour and says so", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);
  await syncMirror({ source: working, mirror });

  // Simulate a mirror created before markers existed.
  await git(["--git-dir", mirror, "update-ref", "-d", "refs/substrate/last-refresh/main"]);
  assert.equal(await git(["--git-dir", mirror, "for-each-ref", "refs/substrate"]), "");

  await rewriteHistory(working, "purged history");
  const divergences = await findMirrorDivergence(working, mirror);
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0]?.pending, 2);

  const refused = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no last-refresh markers/);
  assert.match(refused.stderr, /One forced refresh writes the markers/);

  // One forced refresh restores the markers, after which rewrites pass again.
  assert.equal(await syncMirror({ source: working, mirror, force: true }), "refreshed");
  assert.notEqual(await git(["--git-dir", mirror, "for-each-ref", "refs/substrate"]), "");
  await rewriteHistory(working, "second purge");
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");
});

test("markers stay correct across consecutive refreshes", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await syncMirror({ source: working, mirror });

  const markerTip = async () =>
    git(["--git-dir", mirror, "rev-parse", "refs/substrate/last-refresh/main"]);
  assert.equal(await markerTip(), await git(["-C", working, "rev-parse", "main"]));

  // Each refresh must rewrite the markers after the fetch, which prunes them.
  for (const version of ["second", "third"]) {
    await writeFile(join(working, "vault-note.md"), `${version} version\n`);
    await git(["-C", working, "commit", "-q", "-am", `${version} mac commit`]);
    assert.equal(await syncMirror({ source: working, mirror }), "refreshed");
    assert.equal(await markerTip(), await git(["-C", working, "rev-parse", "main"]));
  }

  // A no-op refresh keeps them too.
  assert.equal(await syncMirror({ source: working, mirror }), "fresh");
  assert.equal(await markerTip(), await git(["-C", working, "rev-parse", "main"]));
});

test("a tag sharing a branch name does not confuse the comparison", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await git(["-C", working, "checkout", "-q", "-b", "v1"]);
  await writeFile(join(working, "release.md"), "release\n");
  await git(["-C", working, "add", "release.md"]);
  await git(["-C", working, "commit", "-q", "-m", "release commit"]);
  await git(["-C", working, "checkout", "-q", "main"]);
  await syncMirror({ source: working, mirror });

  // `%(refname:short)` would render the branch as `heads/v1` in the mirror
  // (where the tag exists) and `v1` in the source, so the two sides would no
  // longer line up and the branch would read as missing upstream.
  await git(["--git-dir", mirror, "tag", "v1", "refs/heads/main"]);
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);
  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");
});

test("a source path containing a colon still compares correctly", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  // A colon separates entries in GIT_ALTERNATE_OBJECT_DIRECTORIES, so an
  // unquoted path here silently truncates and the guard misreads the mirror.
  const nested = join(root, "vault:colon");
  await mkdir(nested, { recursive: true });
  const { working, mirror } = await makeVault(nested);
  assert.equal(await syncMirror({ source: working, mirror }), "created");

  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);
  assert.deepEqual(await findMirrorDivergence(working, mirror), []);

  const stale = await reportMirrorStatus({ source: working, mirror });
  assert.equal(stale.code, STATUS_STALE);
  assert.match(stale.line, /^stale: mirror main is 1 commit behind the working vault/);

  assert.equal(await syncMirror({ source: working, mirror }), "refreshed");
  await commitInMirror(mirror, "phone commit");
  assert.deepEqual(
    await findMirrorDivergence(working, mirror),
    [{ branch: "main", pending: 1, deletedUpstream: false }],
  );
});

test("status.ts stays on one line for a source with no commits", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await syncMirror({ source: working, mirror });

  const empty = join(root, "empty-vault");
  await git(["init", "-q", "-b", "main", empty]);
  const report = await reportMirrorStatus({ source: empty, mirror });
  assert.equal(report.code, STATUS_ERROR);
  assert.match(report.line, /^error: source working repository has no commits on main yet/);

  const cli = await run(statusScript, ["--source", empty, "--mirror", mirror]);
  assert.equal(cli.code, 3);
  assert.equal(cli.stdout.trimEnd().split("\n").length, 1);
  assert.equal(cli.stderr, "");
});

test("--quiet-if-fresh prints nothing when the mirror is up to date", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  assert.equal(await syncMirror({ source: working, mirror }), "created");

  const quiet = await run(mirrorScript, ["--source", working, "--mirror", mirror, "--quiet-if-fresh"]);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.stderr, "");

  // Without the flag the same state still reports.
  const loud = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  assert.equal(loud.code, 0);
  assert.match(loud.stdout, /already up to date: bare vault mirror/);

  // New Mac work is announced even with the flag set.
  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);
  const refreshed = await run(mirrorScript, ["--source", working, "--mirror", mirror, "--quiet-if-fresh"]);
  assert.equal(refreshed.code, 0);
  assert.match(refreshed.stdout, /^refreshed bare vault mirror/);
});

test("status.ts reports fresh, stale, and diverged with matching exit codes", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  await syncMirror({ source: working, mirror });

  const fresh = await reportMirrorStatus({ source: working, mirror });
  assert.equal(fresh.code, STATUS_FRESH);
  assert.match(fresh.line, /^fresh: mirror main matches the working vault at [0-9a-f]{12}$/);
  assert.equal((await run(statusScript, ["--source", working, "--mirror", mirror])).code, 0);

  await writeFile(join(working, "vault-note.md"), "second version\n");
  await git(["-C", working, "commit", "-q", "-am", "mac commit"]);
  await writeFile(join(working, "vault-note.md"), "third version\n");
  await git(["-C", working, "commit", "-q", "-am", "another mac commit"]);
  const stale = await reportMirrorStatus({ source: working, mirror });
  assert.equal(stale.code, STATUS_STALE);
  assert.match(stale.line, /^stale: mirror main is 2 commits behind the working vault/);
  const staleCli = await run(statusScript, ["--source", working, "--mirror", mirror]);
  assert.equal(staleCli.code, 1);
  assert.match(staleCli.stdout, /^stale: /);

  await syncMirror({ source: working, mirror });
  await commitInMirror(mirror, "phone commit");
  const diverged = await reportMirrorStatus({ source: working, mirror });
  assert.equal(diverged.code, STATUS_DIVERGED);
  assert.match(diverged.line, /^diverged: mirror holds 1 commit not in the working vault — main \+1; pull before refreshing$/);
  const divergedCli = await run(statusScript, ["--source", working, "--mirror", mirror]);
  assert.equal(divergedCli.code, 2);
  assert.match(divergedCli.stdout, /^diverged: /);
});

test("status.ts exits 3 when a repository is missing", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);

  const noMirror = await run(statusScript, ["--source", working, "--mirror", mirror]);
  assert.equal(noMirror.code, 3);
  assert.match(noMirror.stdout, /^error: bare mirror not found/);

  await syncMirror({ source: working, mirror });
  const noSource = await run(statusScript, ["--source", join(root, "absent"), "--mirror", mirror]);
  assert.equal(noSource.code, 3);
  assert.match(noSource.stdout, /^error: source working repository not found/);
});

test("end-to-end guard proof: phone push blocks refresh until pulled", { timeout: 60_000 }, async (t) => {
  const root = await withRoot(t);
  const { working, mirror } = await makeVault(root);
  const transcript: string[] = [];

  await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  await commitInMirror(mirror, "phone commit");

  const refused = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  transcript.push(`mirror refresh (no --force) exit=${refused.code}`, refused.stderr.trim());
  assert.notEqual(refused.code, 0);

  const diverged = await run(statusScript, ["--source", working, "--mirror", mirror]);
  transcript.push(`status exit=${diverged.code}: ${diverged.stdout.trim()}`);
  assert.equal(diverged.code, 2);

  await git(["-C", working, "remote", "add", "vault-sync", mirror]);
  await git(["-C", working, "pull", "-q", "--ff-only", "vault-sync", "main"]);

  const after = await run(mirrorScript, ["--source", working, "--mirror", mirror]);
  transcript.push(`mirror refresh after pull exit=${after.code}: ${after.stdout.trim()}`);
  assert.equal(after.code, 0);

  const fresh = await run(statusScript, ["--source", working, "--mirror", mirror]);
  transcript.push(`status exit=${fresh.code}: ${fresh.stdout.trim()}`);
  assert.equal(fresh.code, 0);

  console.log(transcript.join("\n"));
});
