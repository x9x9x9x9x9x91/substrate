/**
 * The freshness windows, and the rule that no answer is never a green one.
 *
 * The classifier is the whole check — everything else is reading a file and
 * printing a line — and its boundaries are where an out-of-band health surface
 * either earns its place or quietly lies: a window one second too wide reports
 * a dead vault as healthy, and a missing record read as "nothing to report"
 * reproduces exactly the silence the surface exists to break.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  classifyHealth,
  DEFAULT_WINDOWS,
  defaultStatePath,
  HEALTH_ATTENTION,
  HEALTH_ERROR,
  HEALTH_FRESH,
  HEALTH_RECORD_VERSION,
  HEALTH_STALE,
  humanizeAge,
  parseDuration,
  parseHealthArgs,
  readHealthRecord,
  reportSyncHealth,
  type HealthRecord,
  type ReadOutcome,
} from "./sync-health.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/sync-health.ts");

const NOW = 1_800_000_000;
const HOUR = 3600;

function record(overrides: Partial<HealthRecord> = {}): ReadOutcome {
  return {
    kind: "ok",
    record: {
      version: HEALTH_RECORD_VERSION,
      last_attempt_at: NOW - 60,
      last_attempt_leg: "pull",
      last_attempt_ok: true,
      last_push_ok_at: NOW - 120,
      last_pull_ok_at: NOW - 60,
      conflicted: 0,
      ...overrides,
    },
  };
}

/** A scratch directory holding one record file. */
function withStateFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sync-health-"));
  const path = join(dir, "vault-sync-health.json");
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a recent successful sync is the only fresh answer", () => {
  const report = classifyHealth(record(), NOW);
  assert.equal(report.code, HEALTH_FRESH);
  assert.match(report.line, /^fresh: the last pull succeeded 60s ago/);
  assert.match(report.line, /last push 2m ago, last pull 60s ago/);
});

test("the stale window opens exactly when the last success reaches it", () => {
  const atWindow = NOW - DEFAULT_WINDOWS.staleAfterSeconds;
  const justInside = atWindow + 1;

  const inside = classifyHealth(
    record({ last_push_ok_at: justInside, last_pull_ok_at: justInside }),
    NOW,
  );
  assert.equal(inside.code, HEALTH_FRESH, inside.line);

  const reached = classifyHealth(
    record({ last_push_ok_at: atWindow, last_pull_ok_at: atWindow }),
    NOW,
  );
  assert.equal(reached.code, HEALTH_STALE, reached.line);
  assert.match(reached.line, /no successful sync in 6h/);
});

test("a leg whose last word was a failure is never fresh, whatever the other leg did", () => {
  // The case this check exists for. Push only fires when the vault changed, so
  // an old push success stamp on its own is ordinary — a quiet week. What is
  // not ordinary is that leg having failed since, while the 5-minute auto-pull
  // keeps the record's newest stamp a minute old: read across the two legs,
  // that machine is fresh forever and nothing it writes ever leaves it.
  const report = classifyHealth(
    record({
      last_push_ok_at: NOW - 40 * HOUR,
      last_push_fail_at: NOW - 60,
      last_pull_ok_at: NOW - 60,
    }),
    NOW,
  );
  assert.equal(report.code, HEALTH_STALE, report.line);
  assert.match(report.line, /the push leg has been failing for 60s/);
  assert.match(report.line, /last push 40h ago, last pull 60s ago/);

  // A quiet push leg with no failure since its last success is the legitimate
  // half of the same shape, and stays fresh.
  const quiet = classifyHealth(
    record({ last_push_ok_at: NOW - 40 * HOUR, last_pull_ok_at: NOW - 60 }),
    NOW,
  );
  assert.equal(quiet.code, HEALTH_FRESH, quiet.line);
  assert.match(quiet.line, /last push 40h ago, last pull 60s ago/);

  // …and the leg recovering is what clears it: a failure older than that leg's
  // own last success is history, not a symptom.
  const recovered = classifyHealth(
    record({ last_push_fail_at: NOW - 10 * HOUR, last_push_ok_at: NOW - 120 }),
    NOW,
  );
  assert.equal(recovered.code, HEALTH_FRESH, recovered.line);

  // Both legs down reads as both legs down, in one line.
  const both = classifyHealth(
    record({
      last_push_ok_at: NOW - 3 * HOUR,
      last_pull_ok_at: NOW - 3 * HOUR,
      last_push_fail_at: NOW - 300,
      last_pull_fail_at: NOW - 120,
    }),
    NOW,
  );
  assert.equal(both.code, HEALTH_STALE, both.line);
  assert.match(both.line, /the push leg has been failing for 5m, and the pull leg has been failing for 2m/);
});

test("a stamp from the future is a clock to fix, not a vault to trust", () => {
  // Ages are clamped at zero, so a stamp written under a skewed clock — a dead
  // RTC, a VM resumed before NTP — would otherwise read as age zero for as
  // long as the file exists, and no amount of waiting ages it into the window.
  const skewed = classifyHealth(record({ last_pull_ok_at: NOW + 3 * HOUR }), NOW);
  assert.equal(skewed.code, HEALTH_ATTENTION, skewed.line);
  assert.match(skewed.line, /stamped 3h in the future \(last_pull_ok_at\)/);

  // It outranks the parked merge below it: every line down there is an age,
  // and against a wrong clock those ages mean nothing.
  const parked = classifyHealth(record({ conflicted: 2, last_attempt_at: NOW + HOUR }), NOW);
  assert.equal(parked.code, HEALTH_ATTENTION, parked.line);
  assert.match(parked.line, /in the future \(last_attempt_at\)/);

  // A write that landed a moment before the read, or two clocks a few seconds
  // apart, is not a skewed clock.
  const moments = classifyHealth(record({ last_pull_ok_at: NOW + 30 }), NOW);
  assert.equal(moments.code, HEALTH_FRESH, moments.line);
});

test("a day without a successful sync is a red answer, not a stale one", () => {
  const dead = NOW - DEFAULT_WINDOWS.downAfterSeconds;
  const report = classifyHealth(record({ last_push_ok_at: dead, last_pull_ok_at: dead }), NOW);
  assert.equal(report.code, HEALTH_ATTENTION, report.line);
  assert.match(report.line, /not exchanging with the remote/);
});

test("a vault that has never synced is red however recently it tried", () => {
  const report = classifyHealth(
    record({ last_attempt_at: NOW - 30, last_push_ok_at: null, last_pull_ok_at: null }),
    NOW,
  );
  assert.equal(report.code, HEALTH_ATTENTION, report.line);
  assert.match(report.line, /has ever succeeded/);
  assert.match(report.line, /last push never, last pull never/);
});

test("a parked merge outranks a still-fresh success", () => {
  // The record stops updating from the moment a merge parks — the timer lane
  // stands down — so a fresh-looking stamp beside a conflict count is exactly
  // the state that must not read green.
  const report = classifyHealth(record({ conflicted: 3 }), NOW);
  assert.equal(report.code, HEALTH_ATTENTION, report.line);
  assert.match(report.line, /parked on 3 paths/);
  assert.equal(classifyHealth(record({ conflicted: 1 }), NOW).line.includes("1 path of"), true);
});

test("a failed last attempt is stale, and names which side gave out", () => {
  const transport = classifyHealth(
    record({ last_attempt_ok: false, last_failure: "transport", last_attempt_leg: "push" }),
    NOW,
  );
  assert.equal(transport.code, HEALTH_STALE, transport.line);
  assert.match(transport.line, /the last push failed reaching the remote/);

  const local = classifyHealth(
    record({ last_attempt_ok: false, last_failure: "local", last_attempt_leg: "pull" }),
    NOW,
  );
  assert.equal(local.code, HEALTH_STALE, local.line);
  assert.match(local.line, /failed on this machine/);
});

test("no data is a red answer, never a quiet green one", () => {
  const missing = classifyHealth({ kind: "missing" }, NOW);
  assert.equal(missing.code, HEALTH_ERROR);
  assert.match(missing.line, /never recorded a sync attempt/);

  const unreadable = classifyHealth({ kind: "unreadable", detail: "broken" }, NOW);
  assert.equal(unreadable.code, HEALTH_ERROR);
  assert.match(unreadable.line, /unreadable: broken/);

  const future = classifyHealth({ kind: "unknown-version", version: 9 }, NOW);
  assert.equal(future.code, HEALTH_ERROR);
  assert.match(future.line, /version 9/);
});

test("reading a record separates missing, corrupt and unknown-version files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-health-read-"));
  try {
    assert.equal((await readHealthRecord(join(dir, "absent.json"))).kind, "missing");

    const path = join(dir, "record.json");
    writeFileSync(path, "{ not json");
    assert.equal((await readHealthRecord(path)).kind, "unreadable");

    writeFileSync(path, JSON.stringify({ version: 1 }));
    assert.equal((await readHealthRecord(path)).kind, "unreadable", "a stampless record was read");

    writeFileSync(path, JSON.stringify({ last_attempt_at: 1, last_attempt_ok: true }));
    assert.equal((await readHealthRecord(path)).kind, "unreadable", "a versionless record was read");

    writeFileSync(path, JSON.stringify({ version: 99, last_attempt_at: 1, last_attempt_ok: true }));
    assert.deepEqual(await readHealthRecord(path), { kind: "unknown-version", version: 99 });

    writeFileSync(
      path,
      JSON.stringify({ version: 1, last_attempt_at: NOW, last_attempt_ok: true, extra: "ignored" }),
    );
    const outcome = await readHealthRecord(path);
    assert.equal(outcome.kind, "ok");
    // A record written without the optional leg field is not corrupt; it is a
    // vault whose pushes have never got through, and it reads as such.
    assert.equal(
      classifyHealth(outcome, NOW).code,
      HEALTH_ATTENTION,
      "a record with no successful leg was not red",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not a record never gets to write the line", async () => {
  // The day the state path points at the wrong file — a log, a config, a
  // credential store — this check still prints one line to a dashboard. None
  // of it may be that file's own bytes.
  const dir = mkdtempSync(join(tmpdir(), "sync-health-echo-"));
  try {
    const path = join(dir, "record.json");
    writeFileSync(path, "remote-token = hunter2-not-a-record\n");
    const corrupt = classifyHealth(await readHealthRecord(path), NOW);
    assert.equal(corrupt.code, HEALTH_ERROR, corrupt.line);
    assert.match(corrupt.line, /not valid JSON/);
    assert.equal(corrupt.line.includes("hunter2"), false, "the file's bytes reached the line");

    // And a record whose leg field says something the app never writes is
    // reported by the legs this app actually has.
    writeFileSync(
      path,
      JSON.stringify({
        version: HEALTH_RECORD_VERSION,
        last_attempt_at: NOW - 30,
        last_attempt_ok: true,
        last_attempt_leg: "push to hunter2@example.invalid",
        last_pull_ok_at: NOW - 30,
      }),
    );
    const odd = classifyHealth(await readHealthRecord(path), NOW);
    assert.equal(odd.code, HEALTH_FRESH, odd.line);
    assert.match(odd.line, /^fresh: the last sync succeeded/);
    assert.equal(odd.line.includes("hunter2"), false, "an unknown leg name was echoed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durations accept the units a plist gets typed in", () => {
  assert.equal(parseDuration("45"), 45);
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("30m"), 1800);
  assert.equal(parseDuration(" 6h "), 6 * HOUR);
  assert.equal(parseDuration("2d"), 2 * 86_400);
  for (const bad of ["", "-5m", "6 hours", "h", "1.5h"]) {
    assert.throws(() => parseDuration(bad), /not a duration/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("ages read in the coarsest unit that still says something", () => {
  assert.equal(humanizeAge(-10), "0s");
  assert.equal(humanizeAge(89), "89s");
  assert.equal(humanizeAge(90), "2m");
  assert.equal(humanizeAge(6 * HOUR), "6h");
  assert.equal(humanizeAge(3 * 86_400), "3d");
});

test("arguments default to the app's own record and reject an inverted window", () => {
  const defaults = parseHealthArgs([], "/home/someone");
  assert.equal(defaults.state, defaultStatePath("/home/someone"));
  assert.match(defaults.state, /Library\/Application Support\/.*vault-sync-health\.json$/);
  assert.deepEqual(defaults.windows, DEFAULT_WINDOWS);

  const custom = parseHealthArgs(["--state", "/tmp/x.json", "--stale-after", "1h", "--down-after", "2h"]);
  assert.equal(custom.state, "/tmp/x.json");
  assert.deepEqual(custom.windows, { staleAfterSeconds: HOUR, downAfterSeconds: 2 * HOUR });

  assert.throws(
    () => parseHealthArgs(["--down-after", "1h", "--stale-after", "6h"]),
    /must not be shorter/,
  );
  assert.throws(() => parseHealthArgs(["--state"]), /needs a value/);
  assert.throws(() => parseHealthArgs(["--mirror", "x"]), /unknown argument/);
});

test("the whole read is one local file: an absent record still answers", async () => {
  const report = await reportSyncHealth(
    { state: join(tmpdir(), "no-such-substrate-health.json"), windows: DEFAULT_WINDOWS },
    NOW,
  );
  assert.equal(report.code, HEALTH_ERROR, report.line);
});

test("the script prints one line and exits on the documented scale", { timeout: 60_000 }, () => {
  const fresh = JSON.stringify({
    version: HEALTH_RECORD_VERSION,
    last_attempt_at: Math.floor(Date.now() / 1000) - 30,
    last_attempt_leg: "pull",
    last_attempt_ok: true,
    last_pull_ok_at: Math.floor(Date.now() / 1000) - 30,
  });
  withStateFile(fresh, (path) => {
    const run = spawnSync(process.execPath, [SCRIPT, "--state", path], { encoding: "utf8" });
    assert.equal(run.status, HEALTH_FRESH, run.stdout + run.stderr);
    assert.equal(run.stdout.trimEnd().split("\n").length, 1, run.stdout);
    assert.match(run.stdout, /^fresh: /);
  });

  const stale = JSON.stringify({
    version: HEALTH_RECORD_VERSION,
    last_attempt_at: Math.floor(Date.now() / 1000) - 8 * HOUR,
    last_attempt_leg: "push",
    last_attempt_ok: true,
    last_push_ok_at: Math.floor(Date.now() / 1000) - 8 * HOUR,
  });
  withStateFile(stale, (path) => {
    const run = spawnSync(process.execPath, [SCRIPT, "--state", path], { encoding: "utf8" });
    assert.equal(run.status, HEALTH_STALE, run.stdout + run.stderr);
    assert.match(run.stdout, /^stale: /);
  });

  withStateFile("{ not json", (path) => {
    const run = spawnSync(process.execPath, [SCRIPT, "--state", path], { encoding: "utf8" });
    assert.equal(run.status, HEALTH_ERROR, run.stdout + run.stderr);
    assert.match(run.stdout, /^error: /);
  });

  const bad = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, HEALTH_ERROR, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /unknown argument/);
});
