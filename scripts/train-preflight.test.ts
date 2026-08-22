import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// train-preflight.sh: the tracker, not the branch list, decides whether a
// branch may join a merge train — asked at adoption time, by a script, because
// the same rule written as a checklist step was followed by a coordinator who
// still adopted a claimed branch.
//
// Every test here runs against a FAKE HTTP client. That is not only about
// speed: the gate rigs have no API token and must never need one, so a live
// call in this suite would be a permanently red gate on every machine but this
// one. The script's transport is a single overridable command for exactly this
// reason.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

type Rig = { repo: string; fixtures: string; dir: string };

/** An issue payload shaped like the tracker's GraphQL response. */
function issueJson(opts: {
  identifier: string;
  state: string;
  stateType?: string;
  assigneeId?: string;
  assigneeName?: string;
  labels?: string[];
  viewerId?: string;
  /** Seconds ago the newest state transition happened. Default: a day. */
  stateChangedSecondsAgo?: number;
  /**
   * History that carries no state transition at all — the shape a page of
   * comment/label events (or a disabled history) comes back as.
   */
  historyWithoutTransitions?: boolean;
  /**
   * Drop the trailing (younger) Todo transition. Without this the newest event
   * in the page is always an hour old, so no test can exercise an age above
   * 3600s no matter what `stateChangedSecondsAgo` says.
   */
  withoutTrailingTransition?: boolean;
  /** The tracker reporting more history behind this page than it returned. */
  historyHasNextPage?: boolean;
  /** The same, for the label connection. */
  labelsHaveNextPage?: boolean;
  /** Extra history nodes, prepended (older) — used to fill a page. */
  extraHistory?: { createdAt: string; toState: { name: string } | null }[];
}): string {
  const changedAgo = opts.stateChangedSecondsAgo ?? 86_400;
  const history = opts.historyWithoutTransitions
    ? [
        { createdAt: new Date(Date.now() - 60_000).toISOString(), toState: null },
        { createdAt: new Date(Date.now() - 120_000).toISOString() },
      ]
    : [
          ...(opts.extraHistory ?? []),
          // Deliberately oldest-first with the newest transition in the middle:
          // the script must take the max, not the first node it is handed.
          { createdAt: new Date(Date.now() - 86_400_000).toISOString(), toState: { name: "In Progress" } },
          {
            createdAt: new Date(Date.now() - changedAgo * 1000).toISOString(),
            toState: { name: opts.state },
          },
          ...(opts.withoutTrailingTransition
            ? []
            : [{ createdAt: new Date(Date.now() - 3_600_000).toISOString(), toState: { name: "Todo" } }]),
        ];
  return JSON.stringify({
    data: {
      viewer: { id: opts.viewerId ?? "user-me", name: "Coordinator", displayName: "Coordinator" },
      issue: {
        identifier: opts.identifier,
        state: { name: opts.state, type: opts.stateType ?? "started" },
        assignee: opts.assigneeId ? { id: opts.assigneeId, displayName: opts.assigneeName ?? "Someone" } : null,
        labels: {
          nodes: (opts.labels ?? []).map((name) => ({ name })),
          pageInfo: { hasNextPage: opts.labelsHaveNextPage ?? false },
        },
        history: {
          nodes: history,
          pageInfo: { hasNextPage: opts.historyHasNextPage ?? false },
        },
      },
    },
  });
}

/**
 * A repo on `main` with the script, its guard, and a fake HTTP client that
 * answers from a fixture directory keyed by issue id.
 */
function makeRig(dir: string): Rig {
  const repo = join(dir, "repo");
  const fixtures = join(dir, "fixtures");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  cpSync(join(ROOT, "scripts/train-preflight.sh"), join(repo, "scripts/train-preflight.sh"));
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));

  const curl = join(dir, "fake-curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
body=$(cat)
# Kept so a test can ask what was actually SENT — the page size lives in the
# query text, and a page size the parser believes but the query never carried
# is exactly the fault this records.
printf '%s' "$body" > "${dir}/last-request.json"
id=$(printf '%s' "$body" | grep -oE '[A-Z]+-[0-9]+' | head -1)
f="${fixtures}/$id.json"
if [[ -f "$f" ]]; then cat "$f"; else printf '%s' '{"data":{"viewer":{"id":"user-me"},"issue":null}}'; fi
`,
  );
  chmodSync(curl, 0o755);

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Preflight Test");
  git("config", "user.email", "preflight@example.test");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { repo, fixtures, dir };
}

function fixture(rig: Rig, id: string, json: string) {
  writeFileSync(join(rig.fixtures, `${id}.json`), json);
}

function run(rig: Rig, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bash", [join(rig.repo, "scripts/train-preflight.sh"), ...args], {
    cwd: rig.repo,
    env: {
      ...process.env,
      LINEAR_API_KEY: "test-token",
      SUBSTRATE_LINEAR_CURL: join(rig.dir, "fake-curl"),
      ...env,
    },
    encoding: "utf8",
  });
}

function withRig(fn: (rig: Rig) => void) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-preflight-"));
  try {
    fn(makeRig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("no token is a loud refusal, never a silent pass", () => {
  withRig((rig) => {
    fixture(rig, "SUB-1094", issueJson({ identifier: "SUB-1094", state: "Needs Review" }));
    const r = run(rig, ["sub/1094-train-preflight"], { LINEAR_API_KEY: undefined, LINEAR_TOKEN: undefined });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no token, preflight cannot vouch/);
    // The critical property: it did not print a verdict it could not support.
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a branch waiting for review is adopted", () => {
  withRig((rig) => {
    fixture(rig, "SUB-1094", issueJson({ identifier: "SUB-1094", state: "Needs Review" }));
    const r = run(rig, ["sub/1094-train-preflight"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ADOPT\s+sub\/1094-train-preflight\s+SUB-1094: Needs Review/m);
    assert.match(r.stderr, /all 1 candidates are free to adopt/);
  });
});

test("a merge-ready branch is adopted", () => {
  withRig((rig) => {
    fixture(rig, "SUB-1094", issueJson({ identifier: "SUB-1094", state: "Merge-Ready" }));
    assert.equal(run(rig, ["SUB-1094"]).status, 0);
  });
});

// Both spellings exist in the tracker's history and either can be the live one
// after a workflow edit; the hyphen variant alone passing proves nothing about
// the other.
test("the spaced spelling of Merge Ready is adopted too", () => {
  withRig((rig) => {
    fixture(rig, "SUB-1095", issueJson({ identifier: "SUB-1095", state: "Merge Ready" }));
    const r = run(rig, ["SUB-1095"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ADOPT\s+SUB-1095\s+SUB-1095: Merge Ready/m);
  });
});

test("an In Progress issue is a claim — skipped", () => {
  withRig((rig) => {
    fixture(rig, "SUB-1071", issueJson({ identifier: "SUB-1071", state: "In Progress" }));
    const r = run(rig, ["sub/1071-adopted-branch"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^SKIP\s+sub\/1071-adopted-branch\s+SUB-1071: claimed — In Progress/m);
    assert.match(r.stderr, /1 of 1 candidates are not free to adopt/);
  });
});

test("Changes Requested and Needs Call are skipped", () => {
  withRig((rig) => {
    fixture(rig, "SUB-1", issueJson({ identifier: "SUB-1", state: "Changes Requested" }));
    fixture(rig, "SUB-2", issueJson({ identifier: "SUB-2", state: "Needs Call" }));
    const r = run(rig, ["sub/1-a", "sub/2-b"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SUB-1: changes requested/);
    assert.match(r.stdout, /SUB-2: waiting on a human \(Needs Call\)/);
  });
});


test("In Review by someone else is a foreign review — skipped", () => {
  withRig((rig) => {
    fixture(
      rig,
      "SUB-4",
      issueJson({ identifier: "SUB-4", state: "In Review", assigneeId: "user-other", assigneeName: "Reviewer" }),
    );
    const r = run(rig, ["sub/4-d"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /foreign review/);
  });
});

test("In Review held by me is mine to adopt", () => {
  withRig((rig) => {
    fixture(
      rig,
      "SUB-5",
      issueJson({ identifier: "SUB-5", state: "In Review", assigneeId: "user-me", assigneeName: "Coordinator" }),
    );
    const r = run(rig, ["sub/5-e"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ADOPT.*SUB-5: In Review \(Coordinator\)/);
  });
});

test("--actor decides whose In Review it is, not the shared token's viewer", () => {
  // Coordinator lanes share one token, so `viewer` answers "which token asked",
  // not "who is reviewing". --actor is how a caller says which of them they are.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-23",
      issueJson({ identifier: "SUB-23", state: "In Review", assigneeId: "user-other", assigneeName: "Reviewer" }),
    );
    // Without the flag the viewer answers, and the viewer is not the assignee.
    assert.equal(run(rig, ["sub/23-s"]).status, 1);
    // By display name, and by id — both are how the flag is documented.
    assert.equal(run(rig, ["--actor", "Reviewer", "sub/23-s"]).status, 0);
    assert.equal(run(rig, ["--actor", "user-other", "sub/23-s"]).status, 0);
    // A third party stays out, and is told whose name it compared against.
    const r = run(rig, ["--actor", "Someone Else", "sub/23-s"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /foreign review — In Review, held by someone other than Someone Else/);
  });
});

test("--actor does not hand a lane an issue it is not on", () => {
  // The flag names a claim, it does not grant one: the assignee still has to
  // match, or --actor would be a way to adopt anything under review.
  withRig((rig) => {
    fixture(rig, "SUB-24", issueJson({ identifier: "SUB-24", state: "In Review", assigneeId: "user-me", assigneeName: "Coordinator" }));
    const r = run(rig, ["--actor", "Reviewer", "sub/24-t"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /foreign review/);
  });
});

test("In Review with nobody on it is skipped — whose review is unanswerable", () => {
  withRig((rig) => {
    fixture(rig, "SUB-6", issueJson({ identifier: "SUB-6", state: "In Review" }));
    const r = run(rig, ["sub/6-f"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no assignee/);
  });
});

test("a state that changed seconds ago is left to settle", () => {
  withRig((rig) => {
    fixture(rig, "SUB-7", issueJson({ identifier: "SUB-7", state: "Needs Review", stateChangedSecondsAgo: 12 }));
    const r = run(rig, ["sub/7-g"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /freshly claimed — state changed 1\ds ago, inside the 300s settle window/);
  });
});

test("a history with no state transition in it is left to settle, not adopted", () => {
  // History disabled, a schema change, or a page of twenty comment events with
  // the transition pushed off the end: the age question went unanswered, and an
  // unanswered question is the case the settle window exists for.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-18",
      issueJson({ identifier: "SUB-18", state: "Needs Review", historyWithoutTransitions: true }),
    );
    const r = run(rig, ["sub/18-r"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /state age unknown — left to settle/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a state that changed well before the window is adopted", () => {
  // The trailing Todo transition is dropped so the newest event in the page is
  // really the 4000s-old one. With it present the age is 3600s whatever the
  // fixture claims, and the test passes without ever exercising its own name.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-8",
      issueJson({
        identifier: "SUB-8",
        state: "Needs Review",
        stateChangedSecondsAgo: 4000,
        withoutTrailingTransition: true,
      }),
    );
    assert.equal(run(rig, ["sub/8-h"]).status, 0);
    // Straddle the real age from both sides: a window under it adopts, a window
    // over it holds. Only the true age satisfies both.
    assert.equal(run(rig, ["--grace", "3900", "sub/8-h"]).status, 0);
    const held = run(rig, ["--grace", "4200", "sub/8-h"]);
    assert.equal(held.status, 1);
    assert.match(held.stdout, /freshly claimed — state changed 40\d\ds ago/);
  });
});

test("the settle window is tunable", () => {
  withRig((rig) => {
    fixture(rig, "SUB-9", issueJson({ identifier: "SUB-9", state: "Needs Review", stateChangedSecondsAgo: 600 }));
    assert.equal(run(rig, ["sub/9-i"]).status, 0);
    assert.equal(run(rig, ["--grace", "3600", "sub/9-i"]).status, 1);
  });
});

test("a comment-only touch does not count as churn", () => {
  // updatedAt moves when a lane writes its closing comment; only transitions
  // are churn, or every properly parked branch would look freshly claimed.
  withRig((rig) => {
    const doc = JSON.parse(issueJson({ identifier: "SUB-10", state: "Needs Review", stateChangedSecondsAgo: 9000 }));
    doc.data.issue.updatedAt = new Date().toISOString();
    fixture(rig, "SUB-10", JSON.stringify(doc));
    assert.equal(run(rig, ["sub/10-j"]).status, 0);
  });
});

test("a resolved issue is a mismatch, not a candidate", () => {
  withRig((rig) => {
    fixture(rig, "SUB-11", issueJson({ identifier: "SUB-11", state: "Done", stateType: "completed" }));
    const r = run(rig, ["sub/11-k"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /already resolved \(Done\)/);
  });
});

test("an unrecognised state fails closed", () => {
  withRig((rig) => {
    fixture(rig, "SUB-12", issueJson({ identifier: "SUB-12", state: "Icebox", stateType: "backlog" }));
    const r = run(rig, ["sub/12-l"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /unexpected state Icebox/);
  });
});

test("a branch with no issue id in it is skipped, not guessed at", () => {
  withRig((rig) => {
    const r = run(rig, ["sub/filing-batch-protocol"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no issue id in the name/);
  });
});

test("an unknown issue is skipped with the tracker's answer", () => {
  withRig((rig) => {
    const r = run(rig, ["sub/9999-ghost"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SUB-9999: could not read the issue — no such issue/);
  });
});

test("a GraphQL error is skipped, never adopted", () => {
  withRig((rig) => {
    fixture(rig, "SUB-13", JSON.stringify({ errors: [{ message: "Authentication required" }] }));
    const r = run(rig, ["sub/13-m"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /could not read the issue — Authentication required/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("an unreachable tracker is skipped, never adopted", () => {
  withRig((rig) => {
    const dead = join(rig.dir, "dead-curl");
    writeFileSync(dead, "#!/usr/bin/env bash\ncat >/dev/null\nexit 7\n");
    chmodSync(dead, 0o755);
    const r = run(rig, ["sub/14-n"], { SUBSTRATE_LINEAR_CURL: dead });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /could not read the issue/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a non-JSON response is skipped, never adopted", () => {
  withRig((rig) => {
    // A proxy's HTML error page is the realistic shape of this.
    fixture(rig, "SUB-15", "<html><body>502 Bad Gateway</body></html>");
    const r = run(rig, ["sub/15-o"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /response was not JSON/);
  });
});

test("a branch another tree holds is skipped without asking the tracker", () => {
  withRig((rig) => {
    // The local half of the same question, and the one that needs no token:
    // if a worktree is standing on the branch, a lane is standing in it.
    fixture(rig, "SUB-16", issueJson({ identifier: "SUB-16", state: "Needs Review" }));
    const other = join(rig.dir, "other-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "sub/16-p", other], { encoding: "utf8" });
    const r = run(rig, ["sub/16-p"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /another tree holds this branch/);
  });
});

test("a bare id gets the same worktree check a branch name gets", () => {
  // An id names no branch, so a literal branch comparison checks NOTHING for
  // this form — the caller adopting by id would get a strictly weaker gate with
  // nothing in the output saying so. The check matches on the ISSUE instead.
  withRig((rig) => {
    fixture(rig, "SUB-19", issueJson({ identifier: "SUB-19", state: "Needs Review" }));
    const other = join(rig.dir, "other-tree-19");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "sub/19-s", other], { encoding: "utf8" });
    for (const form of ["19", "SUB-19", "sub-19"]) {
      const r = run(rig, [form]);
      assert.equal(r.status, 1, `${form} was not skipped`);
      assert.match(r.stdout, /another tree holds this branch \(sub\/19-s\)/);
    }
  });
});

test("a lane does not skip itself over its own worktree", () => {
  withRig((rig) => {
    fixture(rig, "SUB-17", issueJson({ identifier: "SUB-17", state: "Needs Review" }));
    execFileSync("git", ["-C", rig.repo, "checkout", "-q", "-b", "sub/17-q"], { encoding: "utf8" });
    const r = run(rig, ["sub/17-q"]);
    assert.equal(r.status, 0);
  });
});

// Lane worktrees outlive lanes: on the real fleet 32 trees sat on disk and
// every one of four real candidates was skipped for "another tree holds this
// branch", which is the gate refusing the entire job it exists to do. What a
// tree standing on a branch actually proves is only that the branch was worked
// on once. Live means unfinished work is visible in it — uncommitted changes,
// or commits that were never pushed.
test("a parked worktree — clean and at its pushed tip — does not block adoption", () => {
  withRig((rig) => {
    fixture(rig, "SUB-23", issueJson({ identifier: "SUB-23", state: "Needs Review" }));
    const other = join(rig.dir, "parked-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "sub/23-t", other], { encoding: "utf8" });
    execFileSync("git", ["-C", rig.repo, "update-ref", "refs/remotes/origin/sub/23-t", "refs/heads/sub/23-t"]);
    const r = run(rig, ["sub/23-t"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ADOPT\s+sub\/23-t/);
    // Silence would be worse than the old over-skip: someone reading the output
    // has to be able to see the tree is there before they touch the branch.
    assert.match(r.stderr, /a PARKED worktree stands on sub\/23-t/);
  });
});

test("a dirty worktree is a live lane and still blocks", () => {
  withRig((rig) => {
    fixture(rig, "SUB-24", issueJson({ identifier: "SUB-24", state: "Needs Review" }));
    const other = join(rig.dir, "dirty-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "sub/24-u", other], { encoding: "utf8" });
    execFileSync("git", ["-C", rig.repo, "update-ref", "refs/remotes/origin/sub/24-u", "refs/heads/sub/24-u"]);
    writeFileSync(join(other, "file.txt"), "half-finished work\n");
    const r = run(rig, ["sub/24-u"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /another tree holds this branch/);
  });
});

test("a worktree ahead of its pushed tip is a live lane and still blocks", () => {
  withRig((rig) => {
    fixture(rig, "SUB-25", issueJson({ identifier: "SUB-25", state: "Needs Review" }));
    const other = join(rig.dir, "ahead-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "sub/25-v", other], { encoding: "utf8" });
    // Pushed tip pinned to the base, then a commit that never went anywhere.
    execFileSync("git", ["-C", rig.repo, "update-ref", "refs/remotes/origin/sub/25-v", "refs/heads/sub/25-v"]);
    writeFileSync(join(other, "file.txt"), "committed but unpushed\n");
    execFileSync("git", ["-C", other, "commit", "-qam", "unpushed"], { encoding: "utf8" });
    const r = run(rig, ["sub/25-v"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /another tree holds this branch/);
  });
});

test("a worktree whose branch was never pushed is treated as live", () => {
  // No origin ref means there is nothing to compare against — the tree could
  // hold a lane's entire unpushed output. The unanswerable case fails closed.
  withRig((rig) => {
    fixture(rig, "SUB-26", issueJson({ identifier: "SUB-26", state: "Needs Review" }));
    const other = join(rig.dir, "unpushed-tree");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "-b", "sub/26-w", other], { encoding: "utf8" });
    const r = run(rig, ["sub/26-w"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /another tree holds this branch/);
  });
});

// The second lane on a branch cannot check the branch out — the first one holds
// it — so it gets its tree with `--detach`. That tree emits `HEAD <sha>` and
// `detached` and no branch line at all, which made it invisible to every arm
// above: the gate would adopt a branch a lane was actively editing. A detached
// tree is placed by its HEAD instead.
function branchWithTwoCommits(rig: Rig, branch: string): { base: string; tip: string } {
  const g = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" }).trim();
  const build = join(rig.dir, `build-${branch.replace(/\W/g, "-")}`);
  g("worktree", "add", "-q", "-b", branch, build);
  for (const step of ["first", "second"]) {
    writeFileSync(join(build, "file.txt"), `${step} on ${branch}\n`);
    execFileSync("git", ["-C", build, "commit", "-qam", step], { encoding: "utf8" });
  }
  g("worktree", "remove", build);
  return { base: g("rev-parse", `${branch}~1`), tip: g("rev-parse", branch) };
}

test("a dirty detached tree on the branch's own commits is a live lane", () => {
  withRig((rig) => {
    fixture(rig, "SUB-50", issueJson({ identifier: "SUB-50", state: "Needs Review" }));
    const { base } = branchWithTwoCommits(rig, "sub/50-g");
    const other = join(rig.dir, "detached-dirty");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "--detach", other, base], { encoding: "utf8" });
    writeFileSync(join(other, "file.txt"), "half-finished work\n");
    const r = run(rig, ["sub/50-g"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /a detached tree stands on this branch \(sub\/50-g\)/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a clean detached tree behind the branch tip does not block adoption", () => {
  // The other half of the same rule. Dirtiness alone cannot be the test: every
  // unrelated detached tree on the machine would then block every candidate.
  withRig((rig) => {
    fixture(rig, "SUB-51", issueJson({ identifier: "SUB-51", state: "Needs Review" }));
    const { base } = branchWithTwoCommits(rig, "sub/51-h");
    const other = join(rig.dir, "detached-clean");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "--detach", other, base], { encoding: "utf8" });
    const r = run(rig, ["sub/51-h"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ADOPT\s+sub\/51-h/);
    assert.doesNotMatch(r.stdout, /detached tree/);
  });
});

test("a detached tree standing at the branch tip is a live lane even when clean", () => {
  // The shape `.worktrees/1094-r2` had on the real fleet: detached exactly at
  // the tip because another tree already held the branch.
  withRig((rig) => {
    fixture(rig, "SUB-52", issueJson({ identifier: "SUB-52", state: "Needs Review" }));
    const { tip } = branchWithTwoCommits(rig, "sub/52-i");
    const other = join(rig.dir, "detached-at-tip");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "--detach", other, tip], { encoding: "utf8" });
    // Reached by the issue id too: an id names no branch, so the HEAD is what
    // places the tree for that form as well.
    for (const form of ["sub/52-i", "SUB-52"]) {
      const r = run(rig, [form]);
      assert.equal(r.status, 1, `${form} was not skipped`);
      assert.match(r.stdout, /a detached tree stands on this branch \(sub\/52-i\)/);
    }
  });
});

test("a detached tree that has COMMITTED its own work is a live lane, clean or dirty", () => {
  // Diverged from the tip rather than trailing it. The dirty-tree rule alone
  // misses this shape, and missing it is perverse: committing your work would
  // make your lane LESS visible to the gate than leaving it uncommitted.
  withRig((rig) => {
    fixture(rig, "SUB-53", issueJson({ identifier: "SUB-53", state: "Needs Review" }));
    const { base } = branchWithTwoCommits(rig, "sub/53-j");
    const other = join(rig.dir, "detached-diverged");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "--detach", other, base], { encoding: "utf8" });
    writeFileSync(join(other, "file.txt"), "work only this tree has\n");
    execFileSync("git", ["-C", other, "commit", "-qam", "unpushed lane work"], { encoding: "utf8" });
    const r = run(rig, ["sub/53-j"]); // clean: the work is committed, not pending
    assert.equal(r.status, 1);
    assert.match(r.stdout, /a detached tree stands on this branch \(sub\/53-j\)/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a detached tree at main's tip does not claim branches that already landed", () => {
  // A merged branch's tip is an ancestor of main, so a tree standing at main is
  // trivially "at or ahead of" every merged branch at once — and this repo's
  // primary checkout is permanently in that shape. The tracker has the real
  // answer for a landed branch; the worktree arm must not talk over it.
  withRig((rig) => {
    fixture(rig, "SUB-70", issueJson({ identifier: "SUB-70", state: "Done", stateType: "completed" }));
    const g = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" }).trim();
    branchWithTwoCommits(rig, "sub/70-m");
    g("merge", "-q", "--ff-only", "sub/70-m");
    writeFileSync(join(rig.repo, "file.txt"), "main moved on after the merge\n");
    g("commit", "-qam", "post-merge work on main");
    const mainTip = g("rev-parse", "HEAD");
    g("update-ref", "refs/remotes/origin/main", mainTip);
    const other = join(rig.dir, "detached-at-main");
    execFileSync("git", ["-C", rig.repo, "worktree", "add", "-q", "--detach", other, mainTip], { encoding: "utf8" });
    const r = run(rig, ["sub/70-m"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /detached tree stands on this branch/);
    assert.match(r.stdout, /already resolved \(Done\)/);
  });
});

test("one bad candidate in a batch fails the batch but reports every verdict", () => {
  withRig((rig) => {
    fixture(rig, "SUB-20", issueJson({ identifier: "SUB-20", state: "Needs Review" }));
    fixture(rig, "SUB-21", issueJson({ identifier: "SUB-21", state: "In Progress" }));
    fixture(rig, "SUB-22", issueJson({ identifier: "SUB-22", state: "Merge-Ready" }));
    const r = run(rig, ["sub/20-a", "sub/21-b", "sub/22-c"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ADOPT\s+sub\/20-a/);
    assert.match(r.stdout, /SKIP\s+sub\/21-b/);
    assert.match(r.stdout, /ADOPT\s+sub\/22-c/);
    assert.match(r.stderr, /1 of 3 candidates are not free to adopt/);
  });
});

test("bare ids, prefixed ids and branch names all resolve", () => {
  withRig((rig) => {
    fixture(rig, "SUB-30", issueJson({ identifier: "SUB-30", state: "Needs Review" }));
    for (const form of ["SUB-30", "sub-30", "30", "sub/30-whatever-topic"]) {
      assert.equal(run(rig, [form]).status, 0, `${form} did not resolve`);
    }
  });
});

// The script reads the parser's answer as a stream of `key=value` lines, last
// write wins. Any tracker-controlled string carrying a newline could therefore
// append lines of its own and forge the very fields the verdict is drawn from —
// a claimed issue answering "state=Needs Review" about itself. Whoever can set
// a display name or a label can do this, so the values are folded to one line
// where they are emitted, before any reader sees them.
test("a newline in an assignee name cannot forge a verdict", () => {
  withRig((rig) => {
    fixture(
      rig,
      "SUB-40",
      issueJson({
        identifier: "SUB-40",
        state: "In Progress",
        assigneeId: "user-them",
        assigneeName: "Evil\nstate=Needs Review",
      }),
    );
    const r = run(rig, ["sub/40-x"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /claimed — In Progress/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a newline in a label cannot forge a verdict", () => {
  withRig((rig) => {
    fixture(
      rig,
      "SUB-41",
      issueJson({
        identifier: "SUB-41",
        state: "In Progress",
        labels: ["harmless", "x\nstate=Merge-Ready"],
      }),
    );
    const r = run(rig, ["sub/41-y"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /claimed — In Progress/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a forged age cannot ride in on a label either", () => {
  // The settle window is the second thing a forged line can reach: an injected
  // `laststateage` overwrites the real one and a fresh claim reads as settled.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-42",
      issueJson({
        identifier: "SUB-42",
        state: "Needs Review",
        stateChangedSecondsAgo: 5,
        labels: ["x\nlaststateage=99999"],
      }),
    );
    const r = run(rig, ["sub/42-z"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /freshly claimed/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a saturated history page is an unknown age, not an old one", () => {
  // Oldest-first with the page full: the newest transition is off the end, so
  // the newest node IN the page is stale by construction and reads as settled
  // long ago. A full page answers nothing about when the state last moved.
  withRig((rig) => {
    const filler = Array.from({ length: 18 }, (_, i) => ({
      createdAt: new Date(Date.now() - (200 - i) * 86_400_000).toISOString(),
      toState: { name: "Todo" },
    }));
    fixture(
      rig,
      "SUB-43",
      issueJson({
        identifier: "SUB-43",
        state: "Needs Review",
        stateChangedSecondsAgo: 86_400,
        withoutTrailingTransition: true,
        historyHasNextPage: true,
        extraHistory: filler,
      }),
    );
    const r = run(rig, ["sub/43-a"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /state age unknown — left to settle/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});


/**
 * An issue whose history has outgrown one page: the shape a branch that went
 * through a dual review, a fix round and a re-review comes back as — ten-odd
 * transitions plus label, attachment and comment events. Newest-first, the
 * order the tracker actually pages in, unless a test asks for the reverse.
 */
function busyIssueJson(opts: {
  identifier: string;
  state: string;
  /** Events in the page. Well past the old twenty-event page either way. */
  events?: number;
  /** Age of the newest transition; `null` puts none of them in the page. */
  newestTransitionSecondsAgo?: number | null;
  /** Serve the page oldest-first — the order that must NOT be readable. */
  oldestFirst?: boolean;
}): string {
  const total = opts.events ?? 60;
  const changedAgo =
    opts.newestTransitionSecondsAgo === undefined ? 86_400 : opts.newestTransitionSecondsAgo;
  const newest = (changedAgo ?? 60) * 1000;
  // One event per minute walking backwards, so the page is strictly ordered and
  // the newest transition sits at the head of it — every event behind the page
  // boundary is older than every event in it.
  const nodes = Array.from({ length: total }, (_, i) => ({
    createdAt: new Date(Date.now() - newest - i * 60_000).toISOString(),
    toState: i === 0 && changedAgo !== null ? { name: opts.state } : null,
  }));
  return JSON.stringify({
    data: {
      viewer: { id: "user-me", name: "Coordinator", displayName: "Coordinator" },
      issue: {
        identifier: opts.identifier,
        state: { name: opts.state, type: "started" },
        assignee: null,
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        history: {
          nodes: opts.oldestFirst ? [...nodes].reverse() : nodes,
          // The whole point: there IS more behind this page.
          pageInfo: { hasNextPage: true },
        },
      },
    },
  });
}

test("a busy issue's newest-first page dates the state instead of failing closed", () => {
  // The trap this closes: a page that came back saturated was unreadable no
  // matter what was in it, so an issue with more history than one page could
  // never be adopted — not a settle-window wait, a permanent refusal, and it
  // fires on exactly the branches a train exists for.
  withRig((rig) => {
    fixture(rig, "SUB-50", busyIssueJson({ identifier: "SUB-50", state: "Needs Review" }));
    const r = run(rig, ["sub/50-busy"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ADOPT\s+sub\/50-busy\s+SUB-50: Needs Review/m);
  });
});

test("a busy issue's fresh claim is still caught", () => {
  // The other half of the same read: reading a saturated page must not turn the
  // churn guard off. The newest transition is seconds old and inside the window.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-51",
      busyIssueJson({ identifier: "SUB-51", state: "Needs Review", newestTransitionSecondsAgo: 5 }),
    );
    const r = run(rig, ["sub/51-busy"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /freshly claimed — state changed \d+s ago/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a saturated page served oldest-first is still an unknown age", () => {
  // The order is read off the response, never off the `orderBy` the query asked
  // for. Oldest-first with more behind it means the newest transition may be
  // off the end, and the newest one PRESENT is stale by construction: taking it
  // would read as "settled long ago" and adopt a branch somebody else just took.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-52",
      busyIssueJson({ identifier: "SUB-52", state: "Needs Review", oldestFirst: true }),
    );
    const r = run(rig, ["sub/52-busy"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /state age unknown — left to settle/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a newest-first page carrying no transition at all is an unknown age", () => {
  // Proven order says where the newest transition ISN'T, not when it happened.
  // A full page of comment events dates nothing, and the way out is a deeper
  // page — which the verdict line says out loud.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-53",
      busyIssueJson({
        identifier: "SUB-53",
        state: "Needs Review",
        newestTransitionSecondsAgo: null,
      }),
    );
    const r = run(rig, ["sub/53-busy"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /state age unknown — left to settle/);
    assert.match(r.stdout, /SUBSTRATE_HISTORY_PAGE/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("the page the parser judges is the page the query asked for", () => {
  // These were two numbers before: the query's literal and the parser's env
  // default. A raised override that only reached the parser would make a full
  // page look unsaturated — the failure mode with a wrong ADOPT at the end of
  // it — so the request itself is what gets asserted here.
  withRig((rig) => {
    fixture(rig, "SUB-54", issueJson({ identifier: "SUB-54", state: "Needs Review" }));
    const sent = () => readFileSync(join(rig.dir, "last-request.json"), "utf8");

    assert.equal(run(rig, ["sub/54-page"]).status, 0);
    assert.match(sent(), /history\(first: 100,/);

    assert.equal(run(rig, ["sub/54-page"], { SUBSTRATE_HISTORY_PAGE: "250" }).status, 0);
    assert.match(sent(), /history\(first: 250,/);
  });
});

test("a page size that is not a page size is refused, not interpolated", () => {
  // The override lands inside the query text, so anything but a plain integer
  // is a malformed query at best and a rewritten one at worst. It is a hard
  // error rather than a fallback to the default: a caller who asked for a
  // deeper page and silently got the shallow one is told nothing.
  withRig((rig) => {
    fixture(rig, "SUB-55", issueJson({ identifier: "SUB-55", state: "Needs Review" }));
    for (const bad of ["0", "251", "twenty", "20) { nodes { createdAt } } x: viewer { id "]) {
      const r = run(rig, ["sub/55-page"], { SUBSTRATE_HISTORY_PAGE: bad });
      assert.equal(r.status, 2, `page size ${JSON.stringify(bad)} was not refused`);
      assert.match(r.stderr, /SUBSTRATE_HISTORY_PAGE must be a whole number/);
      assert.doesNotMatch(r.stdout, /ADOPT/);
    }
  });
});

test("a configured team prefix is the only prefix accepted", () => {
  // With a non-default team configured, a literal `SUB-` pattern would accept a
  // FOREIGN team's id and then ask about `ALM-40` — a different, real issue,
  // answering about work nobody named. The prefix that is emitted and the
  // prefix that is accepted have to be the same one.
  withRig((rig) => {
    fixture(rig, "ALM-40", issueJson({ identifier: "ALM-40", state: "Needs Review" }));
    const env = { SUBSTRATE_LINEAR_TEAM_PREFIX: "ALM" };
    assert.equal(run(rig, ["ALM-40"], env).status, 0);
    assert.equal(run(rig, ["alm/40-topic"], env).status, 0);
    // A bare number is team-agnostic and still resolves against the config.
    assert.equal(run(rig, ["40"], env).status, 0);
    // A namespace that names no team constrains nothing, so it still resolves.
    assert.equal(run(rig, ["feature/40-topic"], env).status, 0);
    // The foreign prefix is not silently rewritten into this team's namespace —
    // in the BRANCH-NAME form as much as the bare-id one, which is the form the
    // finding was actually about. The reason matters as much as the exit code:
    // "no issue id" is the gate never asking, whereas a skip on state would
    // mean it asked the tracker about ALM-40 — a different, real issue — and
    // could just as easily have answered ADOPT.
    for (const form of ["SUB-40", "sub/40-x", "feature/sub/40-x"]) {
      const r = run(rig, [form], env);
      assert.equal(r.status, 1, `${form} was not skipped`);
      assert.match(r.stdout, /SKIP\s+\S+\s+no issue id in the name/);
      assert.doesNotMatch(r.stdout, /ADOPT/);
      assert.doesNotMatch(r.stdout, /ALM-40/);
    }
  });
});

test("a refused namespace says which segment refused it and how to get past it", () => {
  // `dev/1076-cli-door` is a real branch shape in this repo and it plainly
  // carries a number, so a bare "no issue id in the name" reads as the gate
  // being broken. The refusal is correct — the namespace names another
  // tracker — but a refusal that looks like a bug is one people route around,
  // and the line has to carry the way out with it.
  withRig((rig) => {
    fixture(rig, "SUB-1076", issueJson({ identifier: "SUB-1076", state: "Needs Review" }));
    const r = run(rig, ["dev/1076-cli-door"]);
    assert.equal(r.status, 1);
    assert.match(
      r.stdout,
      /no issue id in the name \(namespace 'dev' is not this team's prefix — pass the issue id explicitly\)/,
    );
    assert.doesNotMatch(r.stdout, /ADOPT/);
    // The way out the reason names actually works.
    assert.equal(run(rig, ["SUB-1076"]).status, 0);
    // A namespace that names no team is not accused of being one.
    const plain = run(rig, ["feature/nothing-numeric"]);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /no issue id in the name — nothing to check/);
  });
});

test("an answer about a different issue is refused, not read", () => {
  withRig((rig) => {
    fixture(rig, "SUB-45", issueJson({ identifier: "SUB-999", state: "Needs Review" }));
    const r = run(rig, ["sub/45-c"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /answered about SUB-999/);
    assert.doesNotMatch(r.stdout, /ADOPT/);
  });
});

test("a renamed done-type state still counts as resolved", () => {
  // Workflow states get renamed; their type does not change with them. Reading
  // the name alone, a renamed Done lands in the "unexpected state" arm — a skip
  // either way, but one that reads as a bug to investigate rather than a
  // closed issue, and it is only a skip by luck.
  withRig((rig) => {
    fixture(
      rig,
      "SUB-46",
      issueJson({ identifier: "SUB-46", state: "Shipped", stateType: "completed" }),
    );
    const r = run(rig, ["sub/46-d"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /already resolved \(Shipped\)/);
  });
});

test("no candidates is a usage error, not an empty all-clear", () => {
  withRig((rig) => {
    const r = run(rig, []);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nothing to check/);
  });
});

