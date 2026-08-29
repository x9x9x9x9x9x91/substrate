import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/gate-timing-append.sh");

type Row = {
  ts: string;
  host: string;
  gate: string;
  seconds: number | null;
  rc: number | null;
  sha: string;
  scope: string;
};

/** Run the appender against a private file, the way verify-gates.sh calls it. */
function append(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stderr: string } {
  const run = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, SUBSTRATE_GATE_TIMINGS: file, ...env },
  });
  return { status: run.status, stderr: run.stderr };
}

function rows(file: string): Row[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Row);
}

const scratch = () => mkdtempSync(join(tmpdir(), "gate-timing-"));

test("one call per gate leg appends one parseable record with every field", () => {
  const file = join(scratch(), "nested/gate-timings.jsonl");
  const run = append(file, ["lint", "42", "0", "0123456789abcdef", "full"]);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");

  const [row] = rows(file);
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(row.host.length > 0);
  assert.equal(row.gate, "lint");
  assert.equal(row.seconds, 42);
  assert.equal(row.rc, 0);
  assert.equal(row.sha, "0123456789abcdef");
  assert.equal(row.scope, "full");
});

test("records accumulate one per line, keeping each run's rc and scope", () => {
  const file = join(scratch(), "t.jsonl");
  append(file, ["tsc", "7", "0", "aaa", "full"]);
  append(file, ["test", "310", "1", "bbb", "tsc,test"]);

  const all = rows(file);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((r) => [r.gate, r.seconds, r.rc, r.sha, r.scope]),
    [
      ["tsc", 7, 0, "aaa", "full"],
      ["test", 310, 1, "bbb", "tsc,test"],
    ],
  );
});

test("a hostname carrying JSON metacharacters cannot forge a second record", () => {
  const file = join(scratch(), "t.jsonl");
  // hostname(1) is whatever the machine is named; the line has to survive it.
  const fakeBin = scratch();
  const hostname = join(fakeBin, "hostname");
  const evil = 'rig"\\,"gate":"forged';
  writeFileSync(hostname, `#!/bin/sh\nprintf '%s' '${evil}'\n`);
  chmodSync(hostname, 0o755);

  const run = append(file, ["lint", "1", "0", "sha", "full"], {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  });
  assert.equal(run.status, 0);

  const all = rows(file);
  assert.equal(all.length, 1);
  assert.equal(all[0].host, evil);
  assert.equal(all[0].gate, "lint");
});

/* ── the invariant: telemetry never fails a gate run ─────────────────────── */

// Both failure provocations avoid chmod: gate rigs run this suite as root,
// and root writes straight through a 0555 directory or a 0444 file. A regular
// file squatting on the directory path (ENOTDIR) and a directory squatting on
// the file path (EISDIR) refuse everyone, root included.
test("an uncreatable directory warns once and still exits green", () => {
  const dir = scratch();
  writeFileSync(join(dir, "blocker"), "");
  const run = append(join(dir, "blocker/sub/t.jsonl"), ["lint", "1", "0", "sha", "full"]);
  assert.equal(run.status, 0);
  assert.match(run.stderr, /^gate-timing: cannot create .*not recorded\n$/);
});

test("an unappendable target warns once and still exits green", () => {
  const dir = scratch();
  const file = join(dir, "t.jsonl");
  mkdirSync(file);
  const run = append(file, ["lint", "1", "0", "sha", "full"]);
  assert.equal(run.status, 0);
  assert.match(run.stderr, /^gate-timing: cannot append to .*not recorded\n$/);
});

test("a miscounted argument list warns and still exits green", () => {
  const file = join(scratch(), "t.jsonl");
  const run = append(file, ["lint", "1", "0"]);
  assert.equal(run.status, 0);
  assert.match(run.stderr, /expected 5 args/);
});

test("non-numeric seconds and rc land as null rather than invalid JSON", () => {
  const file = join(scratch(), "t.jsonl");
  const run = append(file, ["lint", "", "oops", "sha", "full"]);
  assert.equal(run.status, 0);
  const [row] = rows(file);
  assert.equal(row.seconds, null);
  assert.equal(row.rc, null);
});

test("verify-gates.sh routes every leg through the appender and guards the call", () => {
  const source = readFileSync(join(ROOT, "scripts/verify-gates.sh"), "utf8");
  // The record call sits with the summary arrays, so no leg can bypass it.
  assert.match(source, /TIMES\+=\("\$\(\(end - start\)\)s"\).*\n\s*record_gate_timing /);
  // A checkout without the helper, or a helper that refuses to run, is a no-op.
  assert.match(source, /\[\[ -r "\$GATE_TIMING_APPEND" \]\] \|\| return 0/);
  assert.match(source, /bash "\$GATE_TIMING_APPEND" .*\|\| true/);
});
