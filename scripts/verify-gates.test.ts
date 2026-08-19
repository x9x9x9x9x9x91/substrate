import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// verify-gates.sh's red-gate diagnosis. A red gate used to print
// only the summary row ("e2e FAIL 91s 1 failed, 707 passed"), so finding out
// WHICH spec failed cost an ssh into the CI machine and a grep of the log dir. Now
// each red stage also prints the failing names + first error line.
//
// Hermetic: a throwaway git repo holding only the script, plus stub `npm` /
// `npx` / `cargo` earlier on PATH that cat a fixture and exit with a chosen
// code. The fixtures are verbatim excerpts of what each real tool prints
// (captured from node --test, playwright list, cargo test, tsc, eslint), so
// the extraction is tested against the formats it has to survive.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const FIXTURES: Record<string, string> = {
  tsc: `src/lib/foo.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/lib/bar.ts(40,1): error TS2554: Expected 1 arguments, but got 2.
`,

  test: `✔ passing one (0.293708ms)
✖ failing spec name here (0.33925ms)
ℹ tests 3
ℹ pass 1
ℹ fail 2

✖ failing tests:

test at t.test.js:4:1
✖ failing spec name here (0.33925ms)
  AssertionError [ERR_ASSERTION]: boom mismatch

test at t.test.js:5:1
✖ another failure (0.035417ms)
  Error: kaboom detail
`,

  cargo: `running 3 tests
test tests::ok_one ... ok
test tests::broken_beta ... FAILED

failures:

---- tests::broken_beta stdout ----

thread 'tests::broken_beta' panicked at src/lib.rs:7:32:
beta boom

---- tests::broken_alpha stdout ----

thread 'tests::broken_alpha' panicked at src/lib.rs:6:33:
assertion \`left == right\` failed: alpha detail

failures:
    tests::broken_alpha
    tests::broken_beta

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`,

  e2e: `Running 3 tests using 1 worker
  ✓  1 [chromium] › e2e/x.spec.ts:3:3 › Some Suite › passes fine (2ms)
  ✘  2 [chromium] › e2e/x.spec.ts:4:3 › Some Suite › fails loudly (1ms)


  1) [chromium] › e2e/x.spec.ts:4:3 › Some Suite › fails loudly ───────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "beta"
    Received: "alpha"

  2) [chromium] › e2e/x.spec.ts:5:3 › Some Suite › throws ─────────────────────────────────────

    Error: raw boom

  2 failed
    [chromium] › e2e/x.spec.ts:4:3 › Some Suite › fails loudly ────────────────────────────────
    [chromium] › e2e/x.spec.ts:5:3 › Some Suite › throws ──────────────────────────────────────
  1 passed (402ms)
`,

  // The ios leg: a cross-compile check, so its red shape is rustc's,
  // verbatim from the pre-fix state (ungated `crate::voice::*`).
  // The leading warning is load-bearing: warnings carry `-->` arrows too and
  // print first, so the location line has to be found relative to the error.
  ios: `    Checking substrate v0.1.0 (/repo/src-tauri)
warning: unused variable: \`tail\`
  --> src/history.rs:20:17
   |
20 |         let (id, tail) = split(entry);
   |                 ^^^^

error[E0433]: failed to resolve: could not find \`voice\` in the crate root
  --> src/commands/voice.rs:12:12
   |
12 |     crate::voice::start_capture()
   |            ^^^^^ could not find \`voice\` in the crate root

error[E0433]: failed to resolve: could not find \`voice\` in the crate root
  --> src/commands/voice.rs:31:12
   |
31 |     crate::voice::stop_capture()
   |            ^^^^^ could not find \`voice\` in the crate root

error: could not compile \`substrate\` (lib) due to 2 previous errors
`,

  lint: `
/repo/src/lib/foo.ts
  1:7  error  'unusedVar' is assigned a value but never used  @typescript-eslint/no-unused-vars
  9:1  error  Unexpected console statement  no-console

✖ 2 problems (2 errors, 0 warnings)
`,
};

/** A stub that replaces npm/npx/cargo: print the fixture for $GATE, exit $GATE_RC. */
const TOOL_STUB = String.raw`#!/usr/bin/env bash
# The ios leg asks cargo its version (to catch a cargo/rustc toolchain split)
# before it asks cargo to build anything, so the stub answers that separately.
if [[ "$1" == "--version" ]]; then echo "cargo $CARGO_VERSION (stub)"; exit 0; fi
cat "$FIXTURE_DIR/$GATE.log"
exit "$GATE_RC"
`;

// The ios leg probes its two prerequisites before compiling anything, and both
// probes are real commands on the host — stubbed here so the leg's behaviour is
// the machine's state under test, not this machine's Xcode install.
// (IOS_TARGET_INSTALLED / IOS_SDK_PRESENT are always set by run(), so the stubs
// read them unbraced — String.raw still interpolates ${...}.)
const RUSTC_STUB = String.raw`#!/usr/bin/env bash
# ios_check asks two things: the version (cross-checked against cargo's, since
# a split there means the probe and the compile run on different toolchains)
# and: rustc --print target-libdir --target aarch64-apple-ios
if [[ "$1" == "--version" ]]; then echo "rustc $RUSTC_VERSION (stub)"; exit 0; fi
[[ "$IOS_TARGET_INSTALLED" == 1 ]] || exit 1
echo "$FIXTURE_DIR"   # any real directory stands in for the target's std libdir
`;

const XCRUN_STUB = String.raw`#!/usr/bin/env bash
[[ "$IOS_SDK_PRESENT" == 1 ]] || exit 1
echo /fake/iPhoneOS.sdk
`;

type Repo = { dir: string; bin: string; fixtures: string };

function makeRepo(dir: string): Repo {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  cpSync(join(ROOT, "scripts/verify-gates.sh"), join(repo, "scripts/verify-gates.sh"));
  cpSync(join(ROOT, "scripts/lib/checkout-guard.sh"), join(repo, "scripts/lib/checkout-guard.sh"));

  // The script refuses to run without deps; only its existence is checked.
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/eslint"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(repo, "node_modules/.bin/eslint"), 0o755);

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Gate Test");
  git("config", "user.email", "gate@example.test");
  git("add", "-A");
  git("commit", "-qm", "tooling");

  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["npm", "npx", "cargo"]) {
    writeFileSync(join(bin, tool), TOOL_STUB);
    chmodSync(join(bin, tool), 0o755);
  }
  for (const [tool, body] of [["rustc", RUSTC_STUB], ["xcrun", XCRUN_STUB]]) {
    writeFileSync(join(bin, tool), body);
    chmodSync(join(bin, tool), 0o755);
  }

  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  for (const [gate, body] of Object.entries(FIXTURES)) {
    writeFileSync(join(fixtures, `${gate}.log`), body);
  }

  return { dir: repo, bin, fixtures };
}

function run(repo: Repo, gate: string, rc: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [join(repo.dir, "scripts/verify-gates.sh"), "--only", gate], {
    cwd: repo.dir,
    env: {
      ...process.env,
      PATH: `${repo.bin}:${process.env.PATH}`,
      FIXTURE_DIR: repo.fixtures,
      GATE: gate,
      GATE_RC: rc,
      IOS_TARGET_INSTALLED: "1",
      IOS_SDK_PRESENT: "1",
      CARGO_VERSION: "1.99.0",
      RUSTC_VERSION: "1.99.0",
      ...env,
    },
    encoding: "utf8",
  });
}

function withRepo(fn: (repo: Repo) => void) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-verify-gates-"));
  try {
    fn(makeRepo(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a red gate names the failing specs and the first error line", () => {
  withRepo((repo) => {
    // Each gate's own output shape, in one pass: names must reach stdout, and
    // an error line must come with them where the tool prints one.
    const expected: Record<string, RegExp[]> = {
      tsc: [/error TS2322/, /error TS2554/],
      test: [/✖ failing spec name here/, /✖ another failure/, /AssertionError \[ERR_ASSERTION\]: boom mismatch/],
      cargo: [/tests::broken_alpha/, /tests::broken_beta/, /panicked at src\/lib\.rs/],
      e2e: [/1\) \[chromium\] › e2e\/x\.spec\.ts:4:3 › Some Suite › fails loudly/, /Error: expect\(received\)/],
      // …and the location printed must be the ERROR's, not the warning's.
      ios: [/error\[E0433\]: failed to resolve/, /--> src\/commands\/voice\.rs:12:12/],
      lint: [/foo\.ts:1:7\s+error\s+'unusedVar'/, /foo\.ts:9:1\s+error\s+Unexpected console/],
    };
    for (const [gate, patterns] of Object.entries(expected)) {
      const r = run(repo, gate, "1");
      assert.equal(r.status, 1, `${gate}: expected the gate to stay red`);
      assert.match(r.stdout, new RegExp(`↳ ${gate} failures:`), `${gate}: no diagnosis header\n${r.stdout}`);
      for (const p of patterns) {
        assert.match(r.stdout, p, `${gate}: missing ${p}\n${r.stdout}`);
      }
    }
  });
});

test("every diagnosis line is indented under its header, including the 2nd name", () => {
  withRepo((repo) => {
    // A multi-line block passed as one printf arg indents only its first line
    // and leaves the rest flush left, where it reads like the summary table.
    for (const gate of Object.keys(FIXTURES)) {
      const lines = run(repo, gate, "1").stdout.split("\n");
      const start = lines.findIndex((l) => l.includes(`↳ ${gate} failures:`));
      assert.ok(start >= 0, `${gate}: no diagnosis header`);
      const body = lines.slice(start + 1, lines.indexOf("", start));
      assert.ok(body.length > 0, `${gate}: empty diagnosis`);
      for (const l of body) {
        assert.match(l, /^ {6}\S/, `${gate}: unindented diagnosis line: ${JSON.stringify(l)}`);
      }
    }
  });
});

test("cargo shows the summary's clean name list, not the stdout-dump headers", () => {
  withRepo((repo) => {
    const r = run(repo, "cargo", "1");
    // "---- tests::broken_beta stdout ----" heads the first `failures:` block;
    // only the second block's bare names should survive.
    assert.ok(!/---- tests::broken_beta stdout ----/.test(r.stdout), `dump header leaked:\n${r.stdout}`);
  });
});

test("a green gate prints no diagnosis at all", () => {
  withRepo((repo) => {
    for (const gate of Object.keys(FIXTURES)) {
      const r = run(repo, gate, "0");
      assert.equal(r.status, 0, `${gate}: expected green\n${r.stderr}`);
      assert.ok(!r.stdout.includes("↳"), `${gate}: diagnosis printed on a PASS\n${r.stdout}`);
    }
  });
});

test("the summary table and logs: line keep their shape (other tooling greps them)", () => {
  withRepo((repo) => {
    const r = run(repo, "e2e", "1");
    assert.match(r.stdout, /^ {2}e2e {4}FAIL {2}\d+s {6}.*failed/m);
    assert.match(r.stdout, /^ {2}logs: \/.+/m);
  });
});

test("the failing-name list is capped, and says how many it dropped", () => {
  withRepo((repo) => {
    const many = Array.from({ length: 14 }, (_, i) => `src/lib/f${i}.ts(1,1): error TS2322: nope ${i}.`).join("\n");
    writeFileSync(join(repo.fixtures, "tsc.log"), `${many}\n`);
    const r = run(repo, "tsc", "1");
    assert.match(r.stdout, /… 4 more \(see log\)/, r.stdout);
    assert.ok(!r.stdout.includes("nope 10"), `cap not applied\n${r.stdout}`);
  });
});

// The ios leg is the only gate whose prerequisites are per-machine
// operator setup, which makes "skip when unprepped" the tempting shape — and
// the wrong one: a leg that skips itself reports green on a machine that
// checked nothing, which is exactly the blindness the leg exists to close.
test("an unprepped machine FAILS the ios leg and is told the command that fixes it", () => {
  withRepo((repo) => {
    const missingTarget = run(repo, "ios", "0", { IOS_TARGET_INSTALLED: "0" });
    assert.equal(missingTarget.status, 1, `missing target must be red\n${missingTarget.stdout}`);
    assert.match(missingTarget.stdout, /rustup target add aarch64-apple-ios/, missingTarget.stdout);
    assert.match(missingTarget.stdout, /^ {2}ios {4}FAIL/m, missingTarget.stdout);

    const missingSdk = run(repo, "ios", "0", { IOS_SDK_PRESENT: "0" });
    assert.equal(missingSdk.status, 1, `missing iPhoneOS SDK must be red\n${missingSdk.stdout}`);
    assert.match(missingSdk.stdout, /xcode-select -s \/Applications\/Xcode\.app/, missingSdk.stdout);
  });
});

test("the ios probe refuses when cargo and rustc are on different toolchains", () => {
  withRepo((repo) => {
    // The probe asks rustc where the target's std lives; the compile runs
    // through cargo. Split those and the answer is about the wrong toolchain —
    // a green probe followed by a failing build, or the reverse. rustup ships
    // the pair in lockstep, so unequal versions are the detectable signature.
    const r = run(repo, "ios", "0", { RUSTC_VERSION: "1.71.0" });
    assert.equal(r.status, 1, `a split toolchain must be red\n${r.stdout}`);
    assert.match(r.stdout, /cargo is 1\.99\.0 but rustc is 1\.71\.0/, r.stdout);
    assert.match(r.stdout, /machine not prepped/, r.stdout);
  });
});

test("the ios probe follows $RUSTC, because that is the compiler cargo will use", () => {
  withRepo((repo) => {
    // cargo honours $RUSTC; a probe that ignores it answers for PATH's rustc
    // and can refuse a machine that would have built perfectly well.
    // A second rustc with its OWN prepped/unprepped switch, so the two can
    // disagree — which is the only way to see WHICH one the leg asked.
    const other = join(repo.bin, "rustc-elsewhere");
    writeFileSync(other, RUSTC_STUB.replace(/IOS_TARGET_INSTALLED/g, "ELSEWHERE_INSTALLED"));
    chmodSync(other, 0o755);
    const r = run(repo, "ios", "0", { RUSTC: other, IOS_TARGET_INSTALLED: "0", ELSEWHERE_INSTALLED: "1" });
    assert.equal(r.status, 0, `PATH's rustc is unprepped but $RUSTC's is, so the leg is green\n${r.stdout}`);

    // …and the reverse: PATH's rustc is prepped, $RUSTC's is not, and the leg
    // must refuse — the answer that counts is the one cargo would get.
    const broken = run(repo, "ios", "0", { RUSTC: other, IOS_TARGET_INSTALLED: "1", ELSEWHERE_INSTALLED: "0" });
    assert.equal(broken.status, 1, broken.stdout);
    assert.match(broken.stdout, /rustup target add aarch64-apple-ios/, broken.stdout);
  });
});

test("the ios location line points at the error, not at a warning printed before it", () => {
  withRepo((repo) => {
    // rustc prints warnings first and they carry `-->` arrows, so the naive
    // "first arrow in the log" sends the reader to an unrelated file.
    const r = run(repo, "ios", "1");
    assert.ok(!r.stdout.includes("src/history.rs:20:17"), `warning location leaked\n${r.stdout}`);
  });
});

test("the ios summary separates an unprepped machine from real compile errors", () => {
  withRepo((repo) => {
    // A handback quotes the table, so the table has to distinguish "operator
    // fix" from "this branch does not build for iOS".
    assert.match(run(repo, "ios", "0", { IOS_TARGET_INSTALLED: "0" }).stdout, /machine not prepped/);
    assert.match(run(repo, "ios", "1").stdout, /\d+ aarch64-apple-ios compile errors/);
    assert.match(run(repo, "ios", "0").stdout, /clean \(check-only, aarch64-apple-ios\)/);
  });
});

test("an unparseable red log still exits red, just without a diagnosis", () => {
  withRepo((repo) => {
    // A gate that dies before printing anything the extractor knows (OOM,
    // missing binary) must not change the verdict.
    writeFileSync(join(repo.fixtures, "test.log"), "Killed: 9\n");
    const r = run(repo, "test", "1");
    assert.equal(r.status, 1);
    assert.ok(!r.stdout.includes("↳"), r.stdout);
  });
});

// 2026-08-18. The gates lock was opt-in discipline ("never run verify-gates.sh
// bare in a fan-out") and six lanes ran it bare anyway that afternoon; the
// script now re-execs itself under scripts/with-gates-lock.sh. Stubbed here:
// the wrap decision is what is under test, not the lock. The other tests in
// this file exercise the third arm — no wrapper in the sandbox at all, which
// is the public mirror's shape (it ships this script, strips the wrapper) —
// so a run without one must proceed bare rather than fail.
function plantLockWrapStub(repo: Repo) {
  const stub = join(repo.dir, "scripts/with-gates-lock.sh");
  writeFileSync(stub, '#!/usr/bin/env bash\necho "LOCK-WRAP: $*"\n');
  chmodSync(stub, 0o755);
}

test("a bare run re-execs under with-gates-lock.sh with its original args", () => {
  withRepo((repo) => {
    plantLockWrapStub(repo);
    // strip the marker so the assertion holds even when this suite itself
    // runs under a held lock
    const env = { ...process.env };
    delete env.SUBSTRATE_GATES_LOCK_HELD;
    const r = spawnSync("bash", [join(repo.dir, "scripts/verify-gates.sh"), "--only", "tsc"], {
      cwd: repo.dir,
      env: { ...env, PATH: `${repo.bin}:${process.env.PATH}`, FIXTURE_DIR: repo.fixtures, GATE: "tsc", GATE_RC: "0" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOCK-WRAP: .*verify-gates\.sh --only tsc/, "the run must hand itself to the wrapper");
    assert.ok(!r.stdout.includes("verify-gates @"), `the gates must not also run bare:\n${r.stdout}`);
  });
});

test("a run already under the lock does not re-wrap", () => {
  withRepo((repo) => {
    plantLockWrapStub(repo);
    const r = run(repo, "tsc", "0", { SUBSTRATE_GATES_LOCK_HELD: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("LOCK-WRAP"), `a wrapped run must not wrap again:\n${r.stdout}`);
    assert.match(r.stdout, /verify-gates @/, "the gates should have run directly");
  });
});
