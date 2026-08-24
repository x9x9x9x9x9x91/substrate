import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// merge-queue.sh — the handshake that lets a second coordinator hand
// reviewed branches to the train that is already running instead of contending
// for the merge lock.
//
// What has to hold, and is covered here:
//  - appending is cheap, idempotent, and touches nothing the train owns;
//  - the pickup point is enforced, not remembered — no claiming mid-merge;
//  - a claim is exclusive while its claimant lives, and returns to the queue
//    when the claimant dies, so a crashed train loses no queued work;
//  - a reclaim leaves a CLEAN entry: the transitions are tested in sequence
//    (claim -> reclaim -> claim -> release), not one at a time, because a
//    stale claim stamp only misbehaves on the second trip through;
//  - what was queued is a sha, and a tip that moved since is refused, not
//    quietly integrated;
//  - a half-written append (the appender died mid-write) is invisible to
//    readers and reaped by prune;
//  - a train being ASSEMBLED — picked, not yet holding the merge lock — is
//    readable by everyone else, and its marker outlives the short-lived shell
//    that wrote it (the coordinator's worktree is the durable liveness) but
//    not the coordinator, nor an abandoned advertisement past its TTL;
//  - the queue survives the merge lock being stolen or deleted.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

type Rig = { repo: string; queue: string; lockDir: string };

function makeRig(dir: string): Rig {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/merge-queue.sh"), join(repo, "scripts/merge-queue.sh"));
  cpSync(join(ROOT, "scripts/with-merge-lock.sh"), join(repo, "scripts/with-merge-lock.sh"));
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Queue Test");
  git("config", "user.email", "queue@example.test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  // The tooling is committed too: a branch checkout would otherwise delete the
  // untracked scripts/ dir out from under the test.
  git("add", "-A");
  git("commit", "-qm", "initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  return {
    repo,
    queue: join(repo, ".git", "substrate-merge-queue"),
    lockDir: join(repo, ".git", "substrate-merge.lock"),
  };
}

/**
 * A feature branch with one commit, left unmerged on main — and PUSHED, i.e.
 * with a matching `refs/remotes/origin/<name>`. The queue pins origin's tip
 * only (an unpushed branch cannot have been reviewed), so a local-only branch
 * models "not pushed yet", not "a normal branch".
 */
function makeBranch(rig: Rig, name: string, opts: { push?: boolean } = {}) {
  const git = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" });
  git("checkout", "-q", "-b", name);
  writeFileSync(join(rig.repo, `${name.replace(/\//g, "_")}.txt`), "work\n");
  git("add", "-A");
  git("commit", "-qm", `work on ${name}`);
  if (opts.push !== false) git("update-ref", `refs/remotes/origin/${name}`, "HEAD");
  git("checkout", "-q", "main");
}

/**
 * Moves a branch's tip on, the way a push after review does: origin moves too,
 * unless `push: false` models a local commit that was never pushed.
 */
function commitOn(rig: Rig, name: string, opts: { push?: boolean } = {}) {
  const git = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" });
  git("checkout", "-q", name);
  writeFileSync(join(rig.repo, `${name.replace(/\//g, "_")}.txt`), "more work\n");
  git("commit", "-qam", `more work on ${name}`);
  if (opts.push !== false) git("update-ref", `refs/remotes/origin/${name}`, "HEAD");
  git("checkout", "-q", "main");
}

/**
 * Backdates a queue entry's mtime, the way sitting in pending/ for a while
 * does. Load-bearing in the claim tests: rename(2) preserves mtime, so a real
 * entry arrives in claimed/ carrying its APPEND time, and any test that claims
 * a just-appended entry is exercising a freshness no production claim has.
 */
const ageEntry = (dir: string, stamp = "202001010000") =>
  execFileSync("touch", ["-t", stamp, onlyEntry(dir)]);

let queueEnv: Record<string, string> = {};

function queue(rig: Rig, ...args: string[]) {
  return spawnSync("bash", [join(rig.repo, "scripts/merge-queue.sh"), ...args], {
    cwd: rig.repo,
    env: { ...process.env, ...queueEnv },
    encoding: "utf8",
  });
}

function queueOk(rig: Rig, ...args: string[]) {
  const res = queue(rig, ...args);
  assert.equal(res.status, 0, `merge-queue.sh ${args.join(" ")} failed: ${res.stderr}${res.stdout}`);
  return res;
}

const entriesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".entry")) : []);
const pendingDir = (rig: Rig) => join(rig.queue, "pending");
const claimedDir = (rig: Rig) => join(rig.queue, "claimed");
const doneDir = (rig: Rig) => join(rig.queue, "done");

/** The one entry in a queue dir — every test below queues one or two. */
const onlyEntry = (dir: string) => join(dir, entriesIn(dir)[0]);
const readEntry = (dir: string) => readFileSync(onlyEntry(dir), "utf8");
const rewriteEntry = (dir: string, fn: (s: string) => string) =>
  writeFileSync(onlyEntry(dir), fn(readEntry(dir)));

const assemblingDir = (rig: Rig) => join(rig.queue, "assembling");
const markers = (rig: Rig) =>
  existsSync(assemblingDir(rig)) ? readdirSync(assemblingDir(rig)).filter((f) => f.endsWith(".marker")) : [];

/** What merge-queue.sh calls this machine — the half of every liveness rule here that is not a pid. */
const HOST = execFileSync("bash", ["-c", "hostname -s 2>/dev/null || hostname"], { encoding: "utf8" }).trim();

/**
 * A marker as another coordinator's `assemble` would leave it. Written by hand
 * because the thing under test is what OTHER lanes see: a marker this test's
 * own worktree wrote is, correctly, its own and invisible to itself.
 */
function writeMarker(
  rig: Rig,
  opts: { host?: string | null; pid: number; tree?: string; ageSeconds?: number; noEpoch?: boolean },
) {
  const host = opts.host === undefined ? HOST : opts.host;
  const tree = opts.tree ?? "/tmp/some-other-lane";
  // Default: written just now. The age backstop only ever fires on a marker
  // that has been advertising for hours, so a test that wants it says so.
  const ageSeconds = opts.ageSeconds ?? 0;
  const startedEpoch = Math.floor(Date.now() / 1000) - ageSeconds;
  mkdirSync(assemblingDir(rig), { recursive: true });
  const path = join(assemblingDir(rig), `${host ?? "nohost"}.${tree.replace(/\//g, "__")}.marker`);
  writeFileSync(
    path,
    [
      // `host: null` writes the field away entirely — a marker naming nobody,
      // which is what a truncated or garbled write leaves behind.
      ...(host === null ? [] : [`host=${host}`]),
      `pid=${opts.pid}`,
      `worktree=${tree}`,
      "started_at=2026-08-22T10:00:00Z",
      ...(opts.noEpoch ? [] : [`started_epoch=${startedEpoch}`]),
      "note=another lane",
      "",
    ].join("\n"),
  );
  // A marker from before started_epoch existed has only its mtime to be judged
  // by, so the age this test asked for has to be put THERE instead.
  if (opts.noEpoch) {
    execFileSync("touch", ["-t", mtimeStamp(ageSeconds), path]);
  }
  return path;
}

/** `touch -t` form for "this many seconds ago" — the mtime fallback's input. */
function mtimeStamp(secondsAgo: number): string {
  const d = new Date(Date.now() - secondsAgo * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * A directory that exists for the life of one test, standing in for a
 * coordinator's worktree. Existence is half the liveness rule, so a marker
 * pointing at a real path is a live coordinator whatever its pid says.
 */
function realTree(rig: Rig, name: string): string {
  const dir = join(rig.repo, "..", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A pid guaranteed not to be running: a child we start and reap. */
function deadPid(): number {
  const res = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(res.stdout.trim());
}

function withRig(fn: (rig: Rig) => void, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-queue-"));
  queueEnv = env;
  try {
    fn(makeRig(dir));
  } finally {
    queueEnv = {};
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---- appending ---- */

test("append queues a branch and reports that no train is running", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    const res = queueOk(rig, "append", "sub/foo", "--issue", "SUB-1");
    assert.match(res.stdout, /appended sub\/foo/);
    assert.match(res.stdout, /NO train is running/);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);

    const entry = readFileSync(join(pendingDir(rig), entriesIn(pendingDir(rig))[0]), "utf8");
    assert.match(entry, /^branch=sub\/foo$/m);
    assert.match(entry, /^issue=SUB-1$/m);
    assert.match(entry, /^appended_by_pid=\d+$/m);

    // The pinned sha is printed so the operator can compare it against what
    // they reviewed — nothing here refreshes the remote-tracking ref it comes
    // from, so the printout is the only place a stale pin is catchable.
    const sha = /^sha=([0-9a-f]{40})$/m.exec(entry)?.[1];
    assert.ok(sha, "entry records a full sha");
    assert.ok(res.stdout.includes(`appended sub/foo @ ${sha}`));
  });
});

test("append names the running train when the merge lock is held by a live pid", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);

    const res = queueOk(rig, "append", "sub/foo");
    assert.match(res.stdout, new RegExp(`running train \\(merge lock held by pid ${process.pid}\\)`));
    // The appender must not have touched the holder's lock in any way.
    assert.deepEqual(readdirSync(rig.lockDir).sort(), ["pid"]);
    assert.equal(readFileSync(join(rig.lockDir, "pid"), "utf8"), `${process.pid}\n`);
  });
});

test("append refuses a branch that does not resolve", () => {
  withRig((rig) => {
    const res = queue(rig, "append", "sub/nope");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no such branch on origin: sub\/nope/);
    assert.equal(entriesIn(pendingDir(rig)).length, 0);
  });
});

test("append is idempotent — a re-run leaves one entry", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    const again = queueOk(rig, "append", "sub/foo");
    assert.match(again.stderr, /already queued/);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
  });
});

test("append skips a branch already merged into main", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    execFileSync("git", ["-C", rig.repo, "merge", "-q", "--no-ff", "-m", "merge foo", "sub/foo"], {
      encoding: "utf8",
    });
    const res = queueOk(rig, "append", "sub/foo");
    assert.match(res.stderr, /already merged into main/);
    assert.equal(entriesIn(pendingDir(rig)).length, 0);
  });
});

/* ---- the pickup boundary ---- */

test("claim is refused while a merge is in progress", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    writeFileSync(join(rig.repo, ".git", "MERGE_HEAD"), "0".repeat(40) + "\n");

    const res = queue(rig, "claim");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /claim only BETWEEN integrations/);
    assert.equal(entriesIn(pendingDir(rig)).length, 1, "a refused claim must leave the queue untouched");
  });
});

test("claim prints branches FIFO and moves them to claimed", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/one");
    makeBranch(rig, "sub/two");
    queueOk(rig, "append", "sub/one");
    queueOk(rig, "append", "sub/two");

    const res = queueOk(rig, "claim");
    assert.deepEqual(res.stdout.trim().split("\n"), ["sub/one", "sub/two"]);
    assert.equal(entriesIn(pendingDir(rig)).length, 0);
    assert.equal(entriesIn(claimedDir(rig)).length, 2);
  });
});

test("--max limits how many a train takes in one boundary", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/one");
    makeBranch(rig, "sub/two");
    queueOk(rig, "append", "sub/one");
    queueOk(rig, "append", "sub/two");

    const res = queueOk(rig, "claim", "--max", "1");
    assert.deepEqual(res.stdout.trim().split("\n"), ["sub/one"]);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
  });
});

test("a live claimant's entries are not handed out twice", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // The claimant recorded is the live merge-lock holder.
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);

    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo");
    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "a second claim must see nothing");
    assert.equal(entriesIn(claimedDir(rig)).length, 1);
  });
});

test("a claim stamps the merge-lock holder, not the short-lived script run", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "claim");

    const entry = readFileSync(join(claimedDir(rig), entriesIn(claimedDir(rig))[0]), "utf8");
    assert.match(entry, new RegExp(`^claimed_by_pid=${process.pid}$`, "m"));
  });
});

test("two trains claiming at the same moment split the queue, never share it", () => {
  withRig((rig) => {
    const branches = ["sub/a", "sub/b", "sub/c", "sub/d", "sub/e", "sub/f"];
    for (const b of branches) {
      makeBranch(rig, b);
      queueOk(rig, "append", b);
    }
    // Age every entry: a queue worth racing is one branches have been sitting
    // in, and an entry claimed while "old" is precisely the shape in which a
    // mid-claim reclaim used to hand one branch to both racers.
    for (const f of readdirSync(pendingDir(rig))) {
      execFileSync("touch", ["-t", "202001010000", join(pendingDir(rig), f)]);
    }
    const script = join(rig.repo, "scripts/merge-queue.sh");
    const out = join(rig.repo, "claimed-out");
    const res = spawnSync(
      "bash",
      ["-c", `bash "${script}" claim >"${out}.1" 2>/dev/null & bash "${script}" claim >"${out}.2" 2>/dev/null & wait`],
      { cwd: rig.repo, env: { ...process.env }, encoding: "utf8" },
    );
    assert.equal(res.status, 0);

    const lines = [`${out}.1`, `${out}.2`]
      .flatMap((f) => readFileSync(f, "utf8").trim().split("\n"))
      .filter(Boolean);
    assert.deepEqual([...lines].sort(), [...branches].sort(), "every branch handed out exactly once");
  });
});

/* ---- crash safety ---- */

test("a dead claimant's branches return to the queue", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "claim");

    // The train died: rewrite its claim stamp to a pid that is gone, which is
    // what a crashed with-merge-lock.sh leaves behind.
    const claimed = join(claimedDir(rig), entriesIn(claimedDir(rig))[0]);
    writeFileSync(claimed, readFileSync(claimed, "utf8").replace(/^claimed_by_pid=.*$/m, `claimed_by_pid=${deadPid()}`));

    const res = queueOk(rig, "claim");
    assert.match(res.stderr, /reclaimed sub\/foo from dead claimant/);
    assert.equal(res.stdout.trim(), "sub/foo", "reclaimed work must be handed to the next train");
  });
});

test("a reclaimed branch is handed out once, not at every later boundary", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "claim");
    rewriteEntry(claimedDir(rig), (e) => e.replace(/^claimed_by_pid=.*$/m, `claimed_by_pid=${deadPid()}`));

    // Boundary 1: the dead train's work comes back and goes to this train.
    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo");
    // Boundaries 2 and 3: it now belongs to a LIVE claimant and must stay put.
    // A stale stamp left on the reclaimed entry would hand it over forever.
    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "a reclaimed branch must not be re-served");
    assert.equal(queueOk(rig, "claim").stdout.trim(), "");

    const entry = readEntry(claimedDir(rig));
    assert.equal(entry.match(/^claimed_by_pid=/gm)?.length, 1, "one claim, one stamp");
    assert.match(entry, new RegExp(`^claimed_by_pid=${process.pid}$`, "m"));
  });
});

test("a live train can release claims it took over from a dead one", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "claim");
    rewriteEntry(claimedDir(rig), (e) => e.replace(/^claimed_by_pid=.*$/m, `claimed_by_pid=${deadPid()}`));
    queueOk(rig, "claim");

    // release matches on the claim stamp, so it only works if the reclaim left
    // the entry stamped with the pid that actually holds it now.
    assert.match(queueOk(rig, "release").stdout, /released 1 claim/);
    assert.equal(entriesIn(claimedDir(rig)).length, 0);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
  });
});

test("an entry returned to pending carries no claim stamp", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "claim");
    queueOk(rig, "release");

    const entry = readEntry(pendingDir(rig));
    assert.doesNotMatch(entry, /^claimed_/m, "entry_field reads the first match — a leftover stamp masks the next claimant");
    assert.match(entry, /^branch=sub\/foo$/m, "everything else about the entry survives the trip");
  });
});

test("a branch that sat in the queue is not re-served the moment it is claimed", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // The normal case: the branch waited. rename(2) keeps mtime, so the entry
    // arrives in claimed/ already older than any grace period — the shape that
    // used to let a second claim reclaim a claim that was still being made.
    ageEntry(pendingDir(rig));
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo");

    for (let i = 0; i < 3; i++) {
      assert.equal(queueOk(rig, "claim").stdout.trim(), "", "a live claim is never reclaimable, however old the queue entry is");
    }
    assert.equal(entriesIn(claimedDir(rig)).length, 1);
    assert.equal(readEntry(claimedDir(rig)).match(/^claimed_by_pid=/gm)?.length, 1, "one claim, one stamp");
  });
});

test("a claim is invisible until it is stamped, so nothing can read it as abandoned", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    ageEntry(pendingDir(rig));
    queueOk(rig, "claim");

    const claimed = readdirSync(claimedDir(rig));
    assert.equal(claimed.length, 1);
    assert.match(readFileSync(join(claimedDir(rig), claimed[0]), "utf8"), /^claimed_by_pid=\d+$/m,
      "every entry a reader can see carries a stamp — there is no unstamped state to time");
  });
});

test("a claim killed between its two renames is handed back by pid, not by age", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    const base = entriesIn(pendingDir(rig))[0];
    const host = execFileSync("bash", ["-c", "hostname -s 2>/dev/null || hostname"], { encoding: "utf8" }).trim();

    // Killed after the claim rename, before the stamp+publish rename: the
    // residue is a staging file naming the claimant that never finished.
    const live = join(claimedDir(rig), `${base}.claiming.${host}.${process.pid}`);
    renameSync(join(pendingDir(rig), base), live);
    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "a claim in flight belongs to a live pid and must not be stolen");
    assert.equal(entriesIn(claimedDir(rig)).length, 0, "and it is invisible to every reader until it is stamped");

    renameSync(live, join(claimedDir(rig), `${base}.claiming.${host}.${deadPid()}`));
    const res = queueOk(rig, "claim");
    assert.match(res.stderr, /died before it was stamped/);
    assert.equal(res.stdout.trim(), "sub/foo", "otherwise the branch silently never lands");
    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "and recovery is not a re-serve either");
  });
});

test("an unstamped entry from an older merge-queue.sh is still recovered once it ages", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "claim");
    // What a pre-two-rename copy of this script leaves when it dies mid-claim.
    // It cannot be produced any more, but a checkout nobody updated can still
    // produce it, and the entry must not be stranded forever.
    rewriteEntry(claimedDir(rig), (e) => e.replace(/^claimed_.*\n/gm, ""));

    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "inside the grace it is left alone — reclaiming it would race the old script's stamp");
    execFileSync("touch", ["-t", "202001010000", onlyEntry(claimedDir(rig))]);
    const res = queueOk(rig, "claim");
    assert.match(res.stderr, /never stamped/);
    assert.equal(res.stdout.trim(), "sub/foo");
  });
});

test("list names an unstamped claim instead of reporting a live pid ''", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "claim");
    rewriteEntry(claimedDir(rig), (e) => e.replace(/^claimed_.*\n/gm, ""));

    assert.match(queueOk(rig, "list").stdout, /UNSTAMPED claim from an older merge-queue\.sh/);
  });
});

test("list surfaces a transition stranded mid-rename instead of hiding it", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    const base = entriesIn(pendingDir(rig))[0];
    // Both in-flight names, which every other reader deliberately cannot see.
    // A human counting queued work has to be told they exist, or they pile up
    // in claimed/ with nothing that makes them look like garbage.
    renameSync(join(pendingDir(rig), base), join(claimedDir(rig), `${base}.claiming.somehost.4242`));
    let out = queueOk(rig, "list").stdout;
    assert.match(out, /IN FLIGHT\s+sub\/foo/);
    assert.match(out, /claiming\.somehost\.4242/);

    renameSync(join(claimedDir(rig), `${base}.claiming.somehost.4242`), join(claimedDir(rig), `${base}.reclaiming`));
    out = queueOk(rig, "list").stdout;
    assert.match(out, /IN FLIGHT\s+sub\/foo/);
    assert.match(out, /\.reclaiming/);
  });
});

test("reclaim refuses a live claimant unless forced", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "claim");

    const refused = queue(rig, "reclaim", "sub/foo");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /still alive/);
    assert.equal(entriesIn(claimedDir(rig)).length, 1);

    const forced = queueOk(rig, "reclaim", "sub/foo", "--force");
    assert.match(forced.stdout, /reclaimed sub\/foo back to pending/);
    assert.doesNotMatch(readEntry(pendingDir(rig)), /^claimed_/m);
  });
});

test("claim is refused while a merge is parked in a SIBLING worktree", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // The train merges in its own tree; the claim is issued from another. The
    // queue is common-dir state, so a worktree-local guard would pass here.
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "side", join(rig.repo, "..", "wt")], {
      encoding: "utf8",
    });
    writeFileSync(join(rig.repo, ".git", "worktrees", "wt", "MERGE_HEAD"), "0".repeat(40) + "\n");

    const res = queue(rig, "claim");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /claim only BETWEEN integrations/);
    assert.match(res.stderr, /wt/, "the offending tree is named, not just asserted to exist");
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
  });
});

test("a claim stamped by another host is left alone", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "claim");

    const claimed = join(claimedDir(rig), entriesIn(claimedDir(rig))[0]);
    writeFileSync(
      claimed,
      readFileSync(claimed, "utf8")
        .replace(/^claimed_by_pid=.*$/m, `claimed_by_pid=${deadPid()}`)
        .replace(/^claimed_by_host=.*$/m, "claimed_by_host=some-other-machine"),
    );

    const res = queueOk(rig, "claim");
    assert.equal(res.stdout.trim(), "", "another host's pid number means nothing here");
    assert.equal(entriesIn(claimedDir(rig)).length, 1);
  });
});

test("a half-written append is invisible to readers and pruned later", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "claim");
    // An appender killed between its write and its rename leaves this.
    const stray = join(rig.queue, "tmp", "0000000001-999-sub__half.entry");
    writeFileSync(stray, "branch=sub/half\n");

    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "a tmp file is not queued work");
    assert.doesNotMatch(queueOk(rig, "list").stdout, /sub\/half/);

    execFileSync("touch", ["-t", "202001010000", stray]);
    queueOk(rig, "prune");
    assert.ok(!existsSync(stray), "prune reaps abandoned tmp files");
  });
});

test("the queue survives the merge lock being deleted under it", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "append", "sub/foo");

    // What a lock steal does to a dead holder's lock.
    rmSync(rig.lockDir, { recursive: true, force: true });

    assert.equal(entriesIn(pendingDir(rig)).length, 1);
    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo");
  });
});

/* ---- assembling: the window between picking branches and taking the lock ---- */

test("assemble advertises a train being built, before any merge lock exists", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");

    const res = queueOk(rig, "assemble", "--note", "union of the reviewed three");
    assert.match(res.stdout, new RegExp(`assembling as ${HOST}:\\d+ in `));
    assert.equal(markers(rig).length, 1, "one coordinator, one marker");

    const marker = readFileSync(join(assemblingDir(rig), markers(rig)[0]), "utf8");
    assert.match(marker, new RegExp(`^host=${HOST}$`, "m"));
    assert.match(marker, /^pid=\d+$/m, "liveness is judged by pid, so the pid is recorded");
    assert.match(marker, /^worktree=\/.+$/m, "and a human is told where to go and look");
    assert.match(marker, /^note=union of the reviewed three$/m);
    assert.match(marker, /^started_at=\d{4}-\d\d-\d\dT/m);
    assert.match(marker, /^started_epoch=\d+$/m, "and the same instant the age backstop can subtract");
  });
});

test("a second coordinator reads the assembly out of the queue instead of racing it", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // Another lane, mid-assembly. It holds no merge lock — that is the whole
    // window: until it takes one there used to be nothing here to read.
    writeMarker(rig, { pid: process.pid, tree: "/tmp/lane-a" });

    assert.match(queueOk(rig, "list").stdout, new RegExp(`ASSEMBLING by ${HOST}:${process.pid} \\(live\\) since .* in /tmp/lane-a`));

    // The claim path says it too, and does not block: the marker is advisory,
    // and a train that has decided to go ahead must still be able to.
    const claimed = queueOk(rig, "claim");
    assert.match(claimed.stderr, new RegExp(`ASSEMBLING by ${HOST}:${process.pid}`));
    assert.match(claimed.stderr, /a train is already being built from this queue/);
    assert.match(claimed.stderr, /in: {4}\/tmp\/lane-a/);
    assert.equal(claimed.stdout.trim(), "sub/foo", "advisory means advisory — nothing is withheld");

    // And an appender is told its branch may ride that union rather than the
    // flatly wrong "NO train is running".
    makeBranch(rig, "sub/bar");
    const appended = queueOk(rig, "append", "sub/bar");
    assert.match(appended.stdout, /a train is being ASSEMBLED right now/);
    assert.doesNotMatch(appended.stdout, /NO train is running/);
  });
});

test("assemble refuses to build a second train over a live one unless forced", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    writeMarker(rig, { pid: process.pid, tree: "/tmp/lane-a" });

    // The refusal is the cheap moment: before a union is built and gated, not
    // after — three near-collisions in ninety minutes cost one fully gated train.
    const refused = queue(rig, "assemble");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /another coordinator is already assembling/);
    assert.equal(markers(rig).length, 1, "and nothing was advertised behind its back");

    const forced = queueOk(rig, "assemble", "--force");
    assert.match(forced.stdout, /assembling as /);
    assert.equal(markers(rig).length, 2, "two coordinators who both mean it are both named");
  });
});

test("a dead assembler's marker is cleared by the next claim, by pid and host", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // A coordinator that died between picking its branches and taking the lock.
    writeMarker(rig, { pid: deadPid(), tree: "/tmp/lane-dead" });

    assert.match(queueOk(rig, "list").stdout, /ASSEMBLING by .*\(DEAD assembler/, "a human sees it for what it is");

    const res = queueOk(rig, "claim");
    assert.match(res.stderr, /died before its train reached the merge lock/);
    assert.equal(markers(rig).length, 0, "the corpse does not wedge the next coordinator");
    assert.equal(res.stdout.trim(), "sub/foo");
    // A corpse is litter, not a warning: naming it would send this coordinator
    // to wait on a train that is already gone.
    assert.doesNotMatch(res.stderr, /a train is already being built/);
    assert.match(queueOk(rig, "assemble").stdout, /assembling as /, "and assembly is free again");
  });
});

test("a marker whose pid died with its tool call still speaks for a live coordinator", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // The shape the marker's primary consumer actually has: a coordinator that
    // drives this script through discrete tool calls, each its own short-lived
    // shell. The pid stamped at `assemble` time is gone seconds later — while
    // that coordinator is still very much building its train, in a worktree
    // that is right there on disk.
    const tree = realTree(rig, "lane-between-calls");
    writeMarker(rig, { pid: deadPid(), tree });

    assert.match(
      queueOk(rig, "list").stdout,
      /ASSEMBLING by .*\(live — pid gone, worktree present \(a coordinator between tool calls\)\)/,
      "and a human is told which of the two live cases this is",
    );

    const claimed = queueOk(rig, "claim");
    assert.match(claimed.stderr, /a train is already being built from this queue/);
    assert.match(claimed.stderr, /that pid is gone; its worktree is still on disk/);
    assert.equal(markers(rig).length, 1, "not litter — the advertisement survives its own shell");

    const refused = queue(rig, "assemble");
    assert.equal(refused.status, 1, "and a second coordinator is still stopped at the cheap moment");
    assert.match(refused.stderr, /another coordinator is already assembling/);
    assert.equal(markers(rig).length, 1);
  });
});

test("a marker is litter only when the pid AND the worktree are both gone", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // Dead pid, and the worktree it named is not on disk: nothing is building
    // this train any more, by either half of the rule.
    writeMarker(rig, { pid: deadPid(), tree: "/tmp/lane-gone-for-good" });

    const assembled = queueOk(rig, "assemble");
    assert.match(assembled.stderr, /died before its train reached the merge lock/);
    assert.match(assembled.stdout, /assembling as /, "assembly is free again");
    assert.equal(markers(rig).length, 1, "and the only marker left is this run's own");

    // prune says the same thing about the same corpse.
    writeMarker(rig, { pid: deadPid(), tree: "/tmp/lane-gone-for-good" });
    assert.equal(markers(rig).length, 2);
    queueOk(rig, "prune");
    assert.equal(markers(rig).length, 1);
  });
});

test("an advertisement past the assembly TTL is reaped loudly, worktree or not", () => {
  withRig(
    (rig) => {
      makeBranch(rig, "sub/foo");
      queueOk(rig, "append", "sub/foo");
      // The case the backstop exists for, and the only one it may fire on: the
      // coordinator walked away, so its pid is gone, but the worktree it named
      // is still right there on disk and the liveness rule alone would keep
      // this advertisement up forever.
      const tree = realTree(rig, "lane-abandoned");
      writeMarker(rig, { pid: deadPid(), tree, ageSeconds: 7 * 3600 });

      assert.match(
        queueOk(rig, "list").stdout,
        /ASSEMBLING by .*\(DEAD — advertising for 7h0m, past the assembly TTL/,
        "a human is told how long it sat, not just that it went",
      );

      const res = queueOk(rig, "claim");
      assert.match(res.stderr, /it had been advertising for 7h0m, past the assembly TTL of 1h0m/);
      assert.match(res.stderr, /If that train is still being built, re-run `assemble` from it\./);
      assert.equal(markers(rig).length, 0);
    },
    { SUBSTRATE_MERGE_QUEUE_ASSEMBLY_TTL: "3600" },
  );
});

test("a running process outranks the TTL — age is the last resort, not the first", () => {
  withRig(
    (rig) => {
      makeBranch(rig, "sub/foo");
      queueOk(rig, "append", "sub/foo");
      // Same host, and a pid this machine can see with kill -0: that is
      // evidence, not a guess, and a train can legitimately be in assembly for
      // as long as its gates take. Reaping it on age would be the queue
      // deleting an advertisement whose process is right there.
      const tree = realTree(rig, "lane-slow-gates");
      writeMarker(rig, { pid: process.pid, tree, ageSeconds: 7 * 3600 });

      assert.match(
        queueOk(rig, "list").stdout,
        new RegExp(`ASSEMBLING by ${HOST}:${process.pid} \\(live\\)`),
        "a process we can see is live, whatever the clock says",
      );
      queueOk(rig, "claim");
      assert.equal(markers(rig).length, 1, "the backstop does not fire on a coordinator that is running");

      const refused = queue(rig, "assemble");
      assert.equal(refused.status, 1, "and it still holds the queue against a second train");
      assert.match(refused.stderr, /another coordinator is already assembling/);
      // The way past a coordinator wedged alive is the one the header names.
      assert.match(queueOk(rig, "assemble", "--force").stdout, /assembling as /);
    },
    { SUBSTRATE_MERGE_QUEUE_ASSEMBLY_TTL: "3600" },
  );
});

test("TTL=0 turns the backstop off — then only host, pid and worktree decide", () => {
  withRig(
    (rig) => {
      makeBranch(rig, "sub/foo");
      queueOk(rig, "append", "sub/foo");
      // Ancient, and live by the worktree half of the rule. With the documented
      // off-switch set, there is nothing left to reap it.
      const tree = realTree(rig, "lane-ancient");
      writeMarker(rig, { pid: deadPid(), tree, ageSeconds: 400 * 3600 });

      queueOk(rig, "claim");
      assert.equal(markers(rig).length, 1, "0 means off, and off means age never fires");
      assert.match(queueOk(rig, "list").stdout, /\(live — pid gone, worktree present/);
      assert.doesNotMatch(queueOk(rig, "list").stdout, /past the assembly TTL/);
    },
    { SUBSTRATE_MERGE_QUEUE_ASSEMBLY_TTL: "0" },
  );
});

for (const bad of ["4h", "-1"]) {
  test(`a TTL of '${bad}' is not silently the off-switch — it falls back to the default, loudly`, () => {
    withRig(
      (rig) => {
        makeBranch(rig, "sub/foo");
        queueOk(rig, "append", "sub/foo");
        // Both are easy to type and neither is a number of seconds. Absorbing
        // them would disable the backstop in a way indistinguishable from the
        // documented 0 — an abandoned marker sitting forever, nobody told why.
        const tree = realTree(rig, "lane-abandoned");
        writeMarker(rig, { pid: deadPid(), tree, ageSeconds: 5 * 3600 });

        const res = queueOk(rig, "claim");
        assert.match(res.stderr, new RegExp(`ASSEMBLY_TTL='${bad}' is not a whole number of seconds`));
        assert.match(res.stderr, /using the default of 14400s/);
        assert.match(res.stderr, /Set it to 0 to turn the assembly backstop off\./);
        // And the default is genuinely in force: four hours, so five hours goes.
        assert.match(res.stderr, /past the assembly TTL of 4h0m/);
        assert.equal(markers(rig).length, 0);
      },
      { SUBSTRATE_MERGE_QUEUE_ASSEMBLY_TTL: bad },
    );
  });
}

test("a marker from before started_epoch existed is still aged, by its mtime", () => {
  withRig(
    (rig) => {
      makeBranch(rig, "sub/foo");
      queueOk(rig, "append", "sub/foo");
      // Written by an older copy of this script: no epoch field at all, so the
      // only age there is is the file's own mtime. Honest, because a marker is
      // written once to tmp/ and renamed into place.
      const tree = realTree(rig, "lane-old-format");
      writeMarker(rig, { pid: deadPid(), tree, ageSeconds: 6 * 3600, noEpoch: true });

      const res = queueOk(rig, "claim");
      assert.match(res.stderr, /past the assembly TTL of 1h0m/, "the mtime fallback is read, not silently dropped");
      assert.equal(markers(rig).length, 0);
    },
    { SUBSTRATE_MERGE_QUEUE_ASSEMBLY_TTL: "3600" },
  );
});

test("another host's marker blocks a second train while it is fresh", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    writeMarker(rig, { host: "some-other-machine", pid: 4242, tree: "/elsewhere/lane" });

    assert.match(
      queueOk(rig, "list").stdout,
      /ASSEMBLING by some-other-machine:4242 \(live on some-other-machine — another host, reported here and never reaped from here\)/,
      "and `list` says which of the honest cases it is, never a bare `live`",
    );

    const refused = queue(rig, "assemble");
    assert.equal(refused.status, 1, "a train being built elsewhere is still a train being built");
    assert.match(refused.stderr, /another coordinator is already assembling/);
    assert.match(refused.stderr, /its pid number and its paths mean nothing here/);
    assert.match(queueOk(rig, "assemble", "--force").stdout, /assembling as /);
  });
});

test("another host's marker is reaped once it is past the TTL — an epoch is an epoch everywhere", () => {
  withRig(
    (rig) => {
      makeBranch(rig, "sub/foo");
      queueOk(rig, "append", "sub/foo");
      // Nothing here can judge a foreign pid or a foreign path — but the age is
      // judgeable, and a foreign marker exempt from the backstop is immortal:
      // it would refuse every `assemble` on this machine for as long as the
      // file existed, with no host able to clear it.
      writeMarker(rig, { host: "some-other-machine", pid: 4242, tree: "/elsewhere/lane", ageSeconds: 9 * 3600 });

      assert.match(queueOk(rig, "list").stdout, /\(DEAD — advertising for 9h0m, past the assembly TTL/);
      const res = queueOk(rig, "claim");
      assert.match(res.stderr, /cleared the assembly marker from some-other-machine:4242/);
      assert.match(res.stderr, /it had been advertising for 9h0m/);
      assert.equal(markers(rig).length, 0, "the queue is not wedged by a machine that never comes back");
    },
    { SUBSTRATE_MERGE_QUEUE_ASSEMBLY_TTL: "3600" },
  );
});

test("a marker naming no host is litter, not an immortal foreigner", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // A truncated or garbled write. Classified `foreign` it would be reapable
    // by no machine on earth and would refuse every coordinator forever, so it
    // is cleared instead — and cleared out loud, because a marker nobody wrote
    // correctly is a bug somebody should see.
    writeMarker(rig, { host: null, pid: process.pid, tree: "/tmp/lane-nameless" });

    assert.match(queueOk(rig, "list").stdout, /\(MALFORMED — no host recorded, so nobody owns it/);

    const res = queueOk(rig, "claim");
    assert.match(res.stderr, /cleared an assembly marker with no host recorded/);
    assert.match(res.stderr, /would refuse every coordinator on every host forever/);
    assert.equal(markers(rig).length, 0);
    assert.doesNotMatch(res.stderr, /a train is already being built/, "litter is cleared, never waited on");
    assert.match(queueOk(rig, "assemble").stdout, /assembling as /);
  });
});

/* ---- assembling: ending an advertisement from somewhere else ---- */

test("assemble --clear ends this worktree's advertisement outright", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    const started = queueOk(rig, "assemble");
    // The invariant is stated where a coordinator walking away will read it.
    assert.match(started.stdout, /run done\/release from this same worktree, or finish with:/);
    assert.match(started.stdout, /assemble --clear/);
    assert.equal(markers(rig).length, 1);

    const cleared = queueOk(rig, "assemble", "--clear");
    assert.match(cleared.stderr, new RegExp(`cleared the assembly marker for ${HOST}:`));
    assert.equal(markers(rig).length, 0, "and the queue is free without handing any claims back");

    // Idempotent, and it says which key it looked for rather than pretending.
    const again = queueOk(rig, "assemble", "--clear");
    assert.match(again.stderr, /nothing to clear/);
    assert.match(again.stderr, /keyed on the worktree that wrote it/);
  });
});

test("a coordinator that assembles here and resolves there can still close its own marker", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // The mandated flow: assemble in the lane worktree, resolve from another
    // tree that shares the same gitdir — and therefore the same queue.
    const other = join(rig.repo, "..", "resolve-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "--detach", other], { encoding: "utf8" });
    const there = (...args: string[]) =>
      spawnSync("bash", [join(rig.repo, "scripts/merge-queue.sh"), ...args], {
        cwd: other,
        env: { ...process.env, ...queueEnv },
        encoding: "utf8",
      });

    queueOk(rig, "assemble");
    queueOk(rig, "claim");
    const resolved = there("done", "sub/foo");
    assert.equal(resolved.status, 0, resolved.stderr);

    // The orphan the worktree key leaves behind: `done` emptied the queue, but
    // it ran where the marker is not, so the advertisement is still up and now
    // blocks every other host until the TTL.
    assert.equal(markers(rig).length, 1, "resolving from elsewhere cannot take down a marker keyed to here");

    // And it is closable without `release --all`, which would also hand back
    // claims this coordinator does not own. The path is the one the marker
    // itself records — which is what `list` prints for a human to copy, and
    // not necessarily the string this test spelled (a tmpdir is a symlink).
    const recorded = /^worktree=(.+)$/m.exec(
      readFileSync(join(assemblingDir(rig), markers(rig)[0]), "utf8"),
    )![1];
    const cleared = there("assemble", "--clear", "--tree", recorded);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stderr, new RegExp(`cleared the assembly marker for ${HOST}:`));
    assert.equal(markers(rig).length, 0);
  });
});

test("--tree without --clear is refused rather than quietly ignored", () => {
  withRig((rig) => {
    const res = queue(rig, "assemble", "--tree", "/tmp/whatever");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--tree only means something with --clear/);
  });
});

/* ---- assembling: reaping a marker is a read then a write, so it takes the lock ---- */

for (const cmd of ["claim", "prune"]) {
  test(`${cmd} reaps assembly markers under the append lock, so a refresh cannot land inside it`, () => {
    withRig(
      (rig) => {
        makeBranch(rig, "sub/foo");
        queueOk(rig, "append", "sub/foo");
        writeMarker(rig, { pid: deadPid(), tree: "/tmp/lane-gone" });

        // `assemble` renames a refresh onto the very path the reap is about to
        // classify and delete, so the two must not interleave. The harness
        // cannot schedule that window directly — what it CAN show is that the
        // window is inside the lock: hold the append lock from here, and the
        // reaping command refuses to proceed rather than scanning around it.
        writeFileSync(join(rig.queue, "append.lock"), `${process.pid}\n`);
        const res = queue(rig, cmd);
        assert.equal(res.status, 1, `${cmd} classified and deleted markers without the lock`);
        assert.match(res.stderr, /another append has held .*append\.lock/);
        assert.equal(markers(rig).length, 1, "and nothing was removed while another writer held it");

        rmSync(join(rig.queue, "append.lock"));
        queueOk(rig, cmd);
        assert.equal(markers(rig).length, 0, "with the lock free, the same corpse goes");
      },
      { SUBSTRATE_MERGE_QUEUE_LOCK_WAIT: "1" },
    );
  });
}

test("assemble stamps its own shell, never a foreign train's merge-lock holder", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // Legal and ordinary: another train holds the merge lock while this
    // coordinator picks its branches. Assembly happens BEFORE this train has a
    // lock, so the holder is somebody else — borrowing its pid would give the
    // marker the wrong identity and a liveness that outlives this coordinator
    // by the whole of that train.
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);

    // Run through an intermediate shell so the stamped $PPID is distinguishable
    // from the lock holder, and record what that shell's pid was.
    const shellPidFile = join(rig.repo, "outer.pid");
    const res = spawnSync(
      "bash",
      // The trailing `exit` matters: bash execs the LAST command of a -c string
      // into its own process, which would hand merge-queue.sh the node runner as
      // its parent and collapse the two pids this test is telling apart.
      [
        "-c",
        `echo $$ > "${shellPidFile}"; bash "${join(rig.repo, "scripts/merge-queue.sh")}" assemble; rc=$?; exit $rc`,
      ],
      { cwd: rig.repo, env: { ...process.env }, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);

    const outerPid = readFileSync(shellPidFile, "utf8").trim();
    const marker = readFileSync(join(assemblingDir(rig), markers(rig)[0]), "utf8");
    assert.match(marker, new RegExp(`^pid=${outerPid}$`, "m"), "the shell that asked for the assembly");
    assert.doesNotMatch(marker, new RegExp(`^pid=${process.pid}$`, "m"), "not the foreign train holding the lock");
  });
});

test("a marker from another host is left alone however dead its pid looks", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    writeMarker(rig, { host: "some-other-machine", pid: deadPid(), tree: "/elsewhere/lane" });

    const res = queueOk(rig, "claim");
    assert.match(res.stderr, /ASSEMBLING by some-other-machine:/, "another host's pid number means nothing here");
    assert.equal(markers(rig).length, 1, "so it is reported, never reaped");
    queueOk(rig, "prune");
    assert.equal(markers(rig).length, 1);
  });
});

test("done clears the marker only once the queue has nothing left to build with", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/one");
    makeBranch(rig, "sub/two");
    queueOk(rig, "append", "sub/one");
    queueOk(rig, "append", "sub/two");
    queueOk(rig, "assemble");
    queueOk(rig, "claim");

    queueOk(rig, "done", "sub/one");
    assert.equal(markers(rig).length, 1, "a train mid-integration is still a train — the sign stays up");

    queueOk(rig, "drop", "sub/two", "--reason", "red union");
    assert.equal(markers(rig).length, 0, "and comes down when there is nothing left to assemble");
  });
});

test("release takes the assembly marker down with the claims it hands back", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "assemble");
    queueOk(rig, "claim");

    const res = queueOk(rig, "release");
    assert.match(res.stderr, /cleared this worktree's assembly marker/);
    assert.equal(markers(rig).length, 0, "a train that gave its branches back is not assembling one");
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
  });
});

test("release --all sweeps assembly markers left on this host too", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // Live, and belonging to a lane this run is not: only the "that train is
    // gone, sweep up after it" hatch is allowed to touch one.
    writeMarker(rig, { pid: process.pid, tree: "/tmp/lane-a" });
    queueOk(rig, "claim");

    queueOk(rig, "release");
    assert.equal(markers(rig).length, 1, "a plain release only ever ends its own advertisement");

    queueOk(rig, "release", "--all");
    assert.equal(markers(rig).length, 0);
  });
});

test("prune reaps a dead coordinator's marker and counts it", () => {
  withRig((rig) => {
    queueOk(rig, "list");
    writeMarker(rig, { pid: deadPid(), tree: "/tmp/lane-dead" });
    writeMarker(rig, { pid: process.pid, tree: "/tmp/lane-live" });

    const res = queueOk(rig, "prune");
    assert.match(res.stdout, /pruned 1 file\(s\)/);
    assert.deepEqual(markers(rig), [`${HOST}.__tmp__lane-live.marker`], "a live coordinator's sign is not litter");
  });
});

test("notify tells a train taking the lock that someone else is already assembling", () => {
  withRig((rig) => {
    // No pending entries at all: notify used to be silent here, and "empty
    // queue" is exactly the reading that makes a second coordinator start.
    writeMarker(rig, { pid: process.pid, tree: "/tmp/lane-a" });
    const res = queueOk(rig, "notify");
    assert.equal(res.status, 0, "notify never fails the merge it is only reporting on");
    assert.match(res.stderr, /a train is already being built from this queue/);
  });
});

test("a marker is complete when it appears — no reader ever sees a half-written one", () => {
  withRig((rig) => {
    queueOk(rig, "assemble");
    // Written to tmp/ and renamed, like every other state change here. The
    // observable consequence: nothing under assembling/ is ever a partial file,
    // and a tmp scrap is invisible to every reader.
    assert.deepEqual(readdirSync(assemblingDir(rig)), markers(rig));
    assert.deepEqual(readdirSync(join(rig.queue, "tmp")), []);
    const marker = readFileSync(join(assemblingDir(rig), markers(rig)[0]), "utf8");
    for (const key of ["host", "pid", "worktree", "started_at", "started_epoch", "note"]) {
      assert.match(marker, new RegExp(`^${key}=`, "m"), `${key} is there the instant the marker is`);
    }
  });
});

/* ---- resolution and reporting ---- */

test("claim refuses — and keeps — a queued branch whose ref has gone away", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // Deleting the local branch is not enough: the queue pinned origin's ref,
    // which is the only one it ever looks at.
    execFileSync("git", ["-C", rig.repo, "branch", "-qD", "sub/foo"], { encoding: "utf8" });
    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo", "a local branch is not what was queued");
    queueOk(rig, "reclaim", "sub/foo", "--force");

    execFileSync("git", ["-C", rig.repo, "update-ref", "-d", "refs/remotes/origin/sub/foo"], { encoding: "utf8" });
    const res = queueOk(rig, "claim");
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /no longer resolves/);
    // Refused, not dropped: "the ref is gone" is one more way of saying this is
    // not what was reviewed, and queued work is a human's to withdraw.
    assert.equal(entriesIn(doneDir(rig)).length, 0);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
    assert.match(res.stderr, /drop sub\/foo/);
  });
});

test("append refuses a branch that was never pushed", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo", { push: false });
    const res = queue(rig, "append", "sub/foo");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /cannot have been reviewed/);
    assert.equal(entriesIn(pendingDir(rig)).length, 0);
  });
});

test("append refuses when the local branch and origin disagree", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    // A local amend or follow-up commit nobody could have reviewed. Pinning
    // origin's tip silently would be worse than refusing: the train would
    // integrate the reviewed commit while the author believes it took theirs.
    commitOn(rig, "sub/foo", { push: false });

    const res = queue(rig, "append", "sub/foo");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /disagree/);
    assert.equal(entriesIn(pendingDir(rig)).length, 0);
  });
});

test("two appends of one branch in the same instant leave exactly one entry", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    const script = join(rig.repo, "scripts/merge-queue.sh");
    const res = spawnSync(
      "bash",
      [
        "-c",
        `bash "${script}" append sub/foo >/dev/null 2>&1 & bash "${script}" append sub/foo >/dev/null 2>&1 & wait`,
      ],
      { cwd: rig.repo, env: { ...process.env }, encoding: "utf8" },
    );
    assert.equal(res.status, 0);

    // The duplicate check is a read followed by a write, so it is taken under
    // an append lock: without one, both racers read an empty queue and both
    // land, and the loser's orphan is served to a train long after the winner
    // merged. This asserts the property, not the mechanism — under load it is
    // the assertion below that catches a check that is not actually atomic.
    assert.equal(entriesIn(pendingDir(rig)).length, 1, "one branch, one queue entry");
    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo");
    assert.equal(queueOk(rig, "claim").stdout.trim(), "", "and no second copy waiting behind it");
  });
});

test("an append lock left by a dead appender is cleared by the next append", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    // Any invocation creates the queue dirs; the lock lives beside them.
    queueOk(rig, "list");
    const lock = join(rig.queue, "append.lock");
    writeFileSync(lock, `${deadPid()}\n`);

    const res = queueOk(rig, "append", "sub/foo");
    assert.match(res.stderr, /dead pid/);
    assert.equal(entriesIn(pendingDir(rig)).length, 1, "the append went through");
    assert.equal(existsSync(lock), false, "and the corpse is gone, not inherited");
  });
});

test("a normal append leaves no lock behind", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    assert.equal(
      existsSync(join(rig.queue, "append.lock")),
      false,
      "a lock the appender forgot to drop stalls every later append",
    );
  });
});

test("an append refuses rather than queue a duplicate past a lock that never frees", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "list");
    // Owned by this test runner: alive, so it is not a corpse to clear, and it
    // will not free either. A duplicate entry is the failure being fixed here,
    // so waiting out the bound and failing loudly beats queueing blind.
    writeFileSync(join(rig.queue, "append.lock"), `${process.pid}\n`);

    const res = spawnSync("bash", [join(rig.repo, "scripts/merge-queue.sh"), "append", "sub/foo"], {
      cwd: rig.repo,
      // The wait is bounded at ten seconds in production; a test that proves
      // the bound exists should not sit through it.
      env: { ...process.env, SUBSTRATE_MERGE_QUEUE_LOCK_WAIT: "1" },
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /held .*append\.lock/);
    assert.equal(entriesIn(pendingDir(rig)).length, 0, "nothing queued behind the operator's back");
  });
});

test("an appender whose lock was taken from under it leaves the new holder's lock alone", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    const lock = join(rig.queue, "append.lock");

    // The steal has to land INSIDE the critical section, which is microseconds
    // wide — polling for it from here would pass whether or not the release is
    // ownership-checked. So it is driven from within: a `git` on PATH that
    // overwrites the lock the first time it is called while the lock exists,
    // which is the `rev-parse` of the pinned sha, between acquire and release.
    const shimDir = join(rig.repo, "shim");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "git");
    writeFileSync(
      shim,
      [
        "#!/bin/bash",
        'if [ "$1" = "rev-parse" ] && [ -f "$STEAL_LOCK" ]; then',
        '  printf "%s\\n" "$STEAL_PID" > "$STEAL_LOCK"',
        "fi",
        'exec /usr/bin/git "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(shim, 0o755);

    const res = spawnSync("bash", [join(rig.repo, "scripts/merge-queue.sh"), "append", "sub/foo"], {
      cwd: rig.repo,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        STEAL_LOCK: lock,
        // Alive, so it reads as a holder rather than a corpse: this is a
        // successor's live lock, and deleting it admits a second appender.
        STEAL_PID: String(process.pid),
      },
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `append failed: ${res.stderr}${res.stdout}`);
    assert.equal(entriesIn(pendingDir(rig)).length, 1, "the append itself still went through");
    assert.equal(existsSync(lock), true, "the successor's lock survives the loser's exit");
    assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid), "and still names its owner");
  });
});

test("prune sweeps append-lock scraps left by dead clearers, not live ones", () => {
  withRig((rig) => {
    queueOk(rig, "list");
    const dead = join(rig.queue, `append.lock.gone.${deadPid()}`);
    const live = join(rig.queue, `append.lock.gone.${process.pid}`);
    writeFileSync(dead, "1\n");
    // A live owner's scrap may still be on its way back to the lock name.
    writeFileSync(live, "1\n");

    queueOk(rig, "prune");
    assert.equal(existsSync(dead), false, "a scrap nothing will ever restore is litter");
    assert.equal(existsSync(live), true, "removing this one would destroy a lock, not tidy one");
  });
});

test("claim drops a queued branch that landed in main meanwhile", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    execFileSync("git", ["-C", rig.repo, "merge", "-q", "--no-ff", "-m", "merge foo", "sub/foo"], {
      encoding: "utf8",
    });

    const res = queueOk(rig, "claim");
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /already in main/);
    assert.equal(entriesIn(doneDir(rig)).length, 1);
  });
});

test("claim drops a branch that landed in origin/main but not local main", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    // Every box that is not the one merging sees the landing here first.
    const git = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" });
    git("branch", "-qf", "elsewhere", "main");
    git("checkout", "-q", "elsewhere");
    git("merge", "-q", "--no-ff", "-m", "merge foo", "sub/foo");
    git("update-ref", "refs/remotes/origin/main", "elsewhere");
    git("checkout", "-q", "main");

    const res = queueOk(rig, "claim");
    assert.equal(res.stdout.trim(), "", "a landed branch must not be handed over as a no-op merge");
    assert.match(res.stderr, /already in main/);
  });
});

test("claim refuses a branch whose tip moved after it was appended", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    commitOn(rig, "sub/foo");

    // What was reviewed is a sha. Integrating the name would land unreviewed work.
    const res = queueOk(rig, "claim");
    assert.equal(res.stdout.trim(), "");
    assert.match(res.stderr, /REFUSING sub\/foo/);
    assert.match(res.stderr, /drop sub\/foo --reason sha-moved/, "the refusal names its own way out");
    assert.equal(entriesIn(pendingDir(rig)).length, 1, "refused, not dropped");
    assert.equal(entriesIn(doneDir(rig)).length, 0);
    assert.match(queueOk(rig, "claim").stderr, /REFUSING/, "and it stays refused until a human re-appends");

    queueOk(rig, "drop", "sub/foo", "--reason", "sha-moved");
    queueOk(rig, "append", "sub/foo");
    assert.equal(queueOk(rig, "claim").stdout.trim(), "sub/foo");
  });
});

test("a refused sha does not consume the claim budget", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/moved");
    makeBranch(rig, "sub/fine");
    queueOk(rig, "append", "sub/moved");
    queueOk(rig, "append", "sub/fine");
    commitOn(rig, "sub/moved");

    const res = queueOk(rig, "claim", "--max", "1");
    assert.equal(res.stdout.trim(), "sub/fine", "a refusal must not eat the slot a good branch needed");
  });
});

test("done and drop archive the entry with a result", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/one");
    makeBranch(rig, "sub/two");
    queueOk(rig, "append", "sub/one");
    queueOk(rig, "append", "sub/two");
    queueOk(rig, "claim");

    queueOk(rig, "done", "sub/one");
    queueOk(rig, "drop", "sub/two", "--reason", "red union");

    const archived = entriesIn(doneDir(rig)).map((f) => readFileSync(join(doneDir(rig), f), "utf8"));
    assert.equal(archived.length, 2);
    assert.ok(archived.some((e) => /branch=sub\/one/.test(e) && /result=merged/.test(e)));
    assert.ok(archived.some((e) => /branch=sub\/two/.test(e) && /result=dropped/.test(e) && /red union/.test(e)));
    assert.equal(entriesIn(claimedDir(rig)).length, 0);
  });
});

test("release hands a train's claims back to the queue", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    mkdirSync(rig.lockDir, { recursive: true });
    writeFileSync(join(rig.lockDir, "pid"), `${process.pid}\n`);
    queueOk(rig, "claim");

    const res = queueOk(rig, "release");
    assert.match(res.stdout, /released 1 claim/);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
  });
});

test("release --all sweeps up claims left by a train that is gone", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    queueOk(rig, "claim");
    rewriteEntry(claimedDir(rig), (e) => e.replace(/^claimed_by_pid=.*$/m, `claimed_by_pid=${deadPid()}`));

    const scoped = queueOk(rig, "release");
    assert.match(scoped.stdout, /released 0 claim/, "release is scoped to this run's own claims");
    assert.match(scoped.stdout, /release --all/, "and points at the escape hatch rather than leaving a dead end");

    assert.match(queueOk(rig, "release", "--all").stdout, /released 1 claim/);
    assert.equal(entriesIn(pendingDir(rig)).length, 1);
    assert.doesNotMatch(readEntry(pendingDir(rig)), /^claimed_/m);
  });
});

test("a flag given as the last argument says so instead of exiting silently", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    const res = queue(rig, "append", "sub/foo", "--issue");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--issue needs a value/);
    assert.equal(entriesIn(pendingDir(rig)).length, 0);
  });
});

test("notify is silent on an empty queue and loud on a full one", () => {
  withRig((rig) => {
    assert.equal(queueOk(rig, "notify").stderr.trim(), "");
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");
    assert.match(queueOk(rig, "notify").stderr, /1 branch\(es\) appended by other sessions/);
  });
});

test("with-merge-lock surfaces queued branches to the train holding the lock", () => {
  withRig((rig) => {
    makeBranch(rig, "sub/foo");
    queueOk(rig, "append", "sub/foo");

    const res = spawnSync("bash", [join(rig.repo, "scripts/with-merge-lock.sh"), "bash", "-c", "true"], {
      cwd: rig.repo,
      env: { ...process.env, WITH_MERGE_LOCK_NO_MIRROR: "1" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /appended by other sessions are waiting/);
    assert.match(res.stderr, /pending {2}sub\/foo/);
  });
});

test("a broken queue script never fails the merge it is only reporting on", () => {
  withRig((rig) => {
    writeFileSync(join(rig.repo, "scripts/merge-queue.sh"), "#!/usr/bin/env bash\nexit 3\n");
    chmodSync(join(rig.repo, "scripts/merge-queue.sh"), 0o755);

    const res = spawnSync("bash", [join(rig.repo, "scripts/with-merge-lock.sh"), "bash", "-c", "true"], {
      cwd: rig.repo,
      env: { ...process.env, WITH_MERGE_LOCK_NO_MIRROR: "1" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
  });
});
