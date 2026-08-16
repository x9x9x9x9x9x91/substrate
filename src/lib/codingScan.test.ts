import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageDays,
  fmtAgeUnix,
  fmtBytes,
  needsAttention,
  sortCodingRepos,
  type CodingRepo,
} from "./codingScan.ts";

const NOW = 1_800_000_000; // fixed "now" for deterministic ages
const DAY = 86_400;

function repo(over: Partial<CodingRepo>): CodingRepo {
  return {
    name: "x",
    disk_bytes: 0,
    current_branch: "main",
    dirty_files: 0,
    last_commit_unix: NOW,
    last_commit_subject: "s",
    branch_total: 1,
    integration_branch: "main",
    lanes_unmerged: 0,
    lanes_oldest_unix: null,
    worktree_count: 0,
    ahead: 0,
    behind: 0,
    error: null,
    ...over,
  };
}

test("needsAttention: dirty, behind, stale lanes, and errors flag; quiet repos don't", () => {
  assert.equal(needsAttention(repo({}), NOW), false);
  assert.equal(needsAttention(repo({ dirty_files: 2 }), NOW), true);
  assert.equal(needsAttention(repo({ behind: 1 }), NOW), true);
  assert.equal(needsAttention(repo({ behind: null }), NOW), false);
  // a lane exactly at the 4d boundary is NOT stale yet; 4d + 1s is
  assert.equal(
    needsAttention(repo({ lanes_unmerged: 1, lanes_oldest_unix: NOW - 4 * DAY }), NOW),
    false
  );
  assert.equal(
    needsAttention(repo({ lanes_unmerged: 1, lanes_oldest_unix: NOW - 4 * DAY - 1 }), NOW),
    true
  );
  // a young unmerged lane is fine
  assert.equal(
    needsAttention(repo({ lanes_unmerged: 3, lanes_oldest_unix: NOW - 2 * DAY }), NOW),
    false
  );
  assert.equal(needsAttention(repo({ error: "fatal: bad object" }), NOW), true);
});

test("sortCodingRepos: attention first, then last-commit desc inside each group", () => {
  const quietOld = repo({ name: "quiet-old", last_commit_unix: NOW - 30 * DAY });
  const quietNew = repo({ name: "quiet-new", last_commit_unix: NOW - 1 * DAY });
  const dirtyOld = repo({ name: "dirty-old", dirty_files: 1, last_commit_unix: NOW - 9 * DAY });
  const dirtyNew = repo({ name: "dirty-new", dirty_files: 5, last_commit_unix: NOW - 3600 });
  const sorted = sortCodingRepos([quietOld, dirtyOld, quietNew, dirtyNew], NOW);
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["dirty-new", "dirty-old", "quiet-new", "quiet-old"]
  );
  // input array is not mutated
  assert.equal(quietOld.name, "quiet-old");
});

test("sortCodingRepos: repos that never committed sink to the end of their group", () => {
  const noCommit = repo({ name: "empty", last_commit_unix: null });
  const committed = repo({ name: "committed", last_commit_unix: NOW - 10 * DAY });
  const sorted = sortCodingRepos([noCommit, committed], NOW);
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["committed", "empty"]
  );
});

test("fmtBytes: GB with one decimal, MB rounded, KB floor — in the given dialect", () => {
  assert.equal(fmtBytes(2.44 * 2 ** 30, "de-DE"), "2,4 GB");
  assert.equal(fmtBytes(512 * 2 ** 20, "de-DE"), "512 MB");
  assert.equal(fmtBytes(100, "de-DE"), "1 KB");
  // the dial, not a hardwired comma — and the whole-number branches
  // group too, so a 1023 MB row is not German under an English dial
  assert.equal(fmtBytes(2.44 * 2 ** 30, "en-US"), "2.4 GB");
  assert.equal(fmtBytes(1023 * 2 ** 20, "en-US"), "1,023 MB");
  assert.equal(fmtBytes(1023 * 2 ** 10, "de-DE"), "1.023 KB");
});

test("fmtAgeUnix / ageDays: compact relative ages", () => {
  assert.equal(fmtAgeUnix(null, NOW), "—");
  assert.equal(fmtAgeUnix(NOW - 12 * 60, NOW), "12m ago");
  assert.equal(fmtAgeUnix(NOW - 5 * 3600, NOW), "5h ago");
  assert.equal(fmtAgeUnix(NOW - 9 * DAY, NOW), "9d ago");
  assert.equal(ageDays(NOW - 9 * DAY - 3600, NOW), 9);
  // future stamps clamp to zero, never negative
  assert.equal(fmtAgeUnix(NOW + 60, NOW), "0m ago");
});
