import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/branch-gates.sh");

// --classify never touches git or a runner, so the mapping is testable as a
// pure function: paths in, "gates = <subset>" out.
function gatesFor(...files: string[]): string {
  const out = execFileSync("bash", [SCRIPT, "--print-only", "--classify", ...files], {
    encoding: "utf8",
  });
  const line = out.split("\n").find((l) => l.startsWith("branch-gates: gates ="));
  assert.ok(line, `no gates line in output:\n${out}`);
  return line.replace("branch-gates: gates = ", "").trim();
}

const FULL = "tsc,test,cargo,ios,e2e,lint,macsmoke";

test("docs and site prose ride the merge train", () => {
  const verdict = gatesFor("README.md", "docs/publish.md", "site/index.html");
  assert.ok(verdict.startsWith("none"), verdict);
});

test("a src diff runs the TS-facing gates plus cargo (a Rust test reads src/)", () => {
  // src-tauri/src/kinds.rs reads src/lib/kinds.ts to keep the built-in kind
  // lists in lockstep, so a src-only branch can red the train's cargo leg.
  assert.equal(gatesFor("src/lib/query.ts"), "tsc,test,cargo,e2e,lint");
  assert.equal(gatesFor("src/lib/kinds.ts"), "tsc,test,cargo,e2e,lint");
});

test("a Rust diff runs cargo+ios+macsmoke and keeps `test` for the TS↔Rust contract suites", () => {
  assert.equal(gatesFor("src-tauri/src/commands/voice.rs"), "test,cargo,ios,macsmoke");
});

test("a scripts diff runs tsc/test/lint (tsconfig includes scripts/)", () => {
  assert.equal(gatesFor("scripts/append-row.ts"), "tsc,test,lint");
});

test("an e2e spec runs e2e+lint — specs sit outside tsc's include", () => {
  assert.equal(gatesFor("e2e/palette.spec.ts"), "e2e,lint");
  assert.equal(gatesFor("playwright.config.ts"), "e2e,lint");
});

test("tiers union across files; src + Rust together is the full seven", () => {
  assert.equal(gatesFor("src/lib/query.ts", "src-tauri/src/lib.rs"), FULL);
});

test("markdown that is DATA classifies by its tree, not as prose", () => {
  // The seeded vault is include_str!'d and asserted by Rust tests...
  assert.equal(gatesFor("src-tauri/src/seed/welcome.md"), "test,cargo,ios,macsmoke");
  assert.equal(gatesFor("src-tauri/src/seed/revisions/AGENTS.md"), "test,cargo,ios,macsmoke");
  // ...the cookbook tree is walked by scripts/cookbook.test.ts...
  assert.equal(gatesFor("cookbook/recipes/x.md"), "test");
  assert.equal(gatesFor("cookbook/index.json"), "test");
  // ...and the example vault is parsed by scripts/example-vault.test.ts and
  // opened as a demo vault by a Rust test in src-tauri/src/commands/app.rs.
  assert.equal(gatesFor("examples/vault/Dashboards/Tasks.md"), "test,cargo");
  // The committed changelog is compared against src/lib/changelog.ts.
  assert.equal(gatesFor("CHANGELOG.md"), "test");
});

test("genuinely inert prose still rides the merge train", () => {
  for (const f of ["docs/foo.md", "docs/design/deep.md", "README.md", "AGENTS.md"]) {
    assert.ok(gatesFor(f).startsWith("none"), f);
  }
});

test("docs files add nothing to a code diff's subset", () => {
  assert.equal(gatesFor("README.md", "scripts/append-row.ts"), "tsc,test,lint");
});

test("build config and gate infrastructure force the full seven", () => {
  for (const f of [
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "vite.config.ts",
    "scripts/verify-gates.sh",
    "scripts/branch-gates.sh",
    "scripts/lib/checkout-guard.sh",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    assert.equal(gatesFor(f), FULL, f);
  }
});

test("an unclassifiable path is conservative: full seven", () => {
  assert.equal(gatesFor("rust-toolchain.toml"), FULL);
  assert.equal(gatesFor("design/options/sketch.md"), FULL);
});

test("the subset is emitted in verify-gates' canonical gate order", () => {
  // Union of scripts (tsc,test,lint) and e2e (e2e,lint) tiers — the output
  // must interleave in canonical order, not concatenate per-tier.
  assert.equal(gatesFor("scripts/append-row.ts", "e2e/palette.spec.ts"), "tsc,test,e2e,lint");
});

// ── The auto-split plan ─────────────────────────────────────────────────────
// --print-plan takes the fleet answer as a VALUE (--mac-free 0|1) instead of
// probing, so the split decision is exercised here without a rig anywhere near
// the test: no ssh, no launch, no wall clock.
function planFor(macFree: "0" | "1", ...files: string[]): string[] {
  const out = execFileSync(
    "bash",
    [SCRIPT, "--print-plan", "--mac-free", macFree, "--classify", ...files],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter((l) => l.startsWith("branch-gates: plan") || l.startsWith("branch-gates: leg"));
}

test("a set needing a Mac splits when no Mac is free: linux-servable leg, mac-only leg", () => {
  assert.deepEqual(planFor("0", "src-tauri/src/lib.rs"), [
    "branch-gates: plan = split",
    "branch-gates: leg A (linux-servable) = test,cargo",
    "branch-gates: leg B (mac-only) = ios,macsmoke",
  ]);
  // The full seven cut the same way: five gates the Linux rigs can serve, and
  // the two that need a Darwin host.
  assert.deepEqual(planFor("0", "package.json"), [
    "branch-gates: plan = split",
    "branch-gates: leg A (linux-servable) = tsc,test,cargo,e2e,lint",
    "branch-gates: leg B (mac-only) = ios,macsmoke",
  ]);
});

test("a free Mac keeps the run single — one run beats two whenever it can be had", () => {
  for (const f of ["src-tauri/src/lib.rs", "package.json"]) {
    assert.deepEqual(planFor("1", f), ["branch-gates: plan = single"], f);
  }
});

test("a set with no mac-only gate never splits, however busy the Macs are", () => {
  // These sets had the Linux rigs as candidates all along — splitting them
  // would buy a second run for nothing.
  for (const f of ["src/lib/query.ts", "scripts/append-row.ts", "e2e/palette.spec.ts", "CHANGELOG.md"]) {
    assert.deepEqual(planFor("0", f), ["branch-gates: plan = single"], f);
  }
});

test("the two legs partition the classified subset — nothing dropped, nothing gated twice", () => {
  const plan = planFor("0", "src/lib/query.ts", "src-tauri/src/lib.rs");
  const legs = plan.filter((l) => l.startsWith("branch-gates: leg")).map((l) => l.split(" = ")[1]);
  const gates = legs.flatMap((l) => l.split(","));
  assert.equal(new Set(gates).size, gates.length, `a gate rides both legs: ${plan.join("\n")}`);
  assert.deepEqual([...gates].sort(), FULL.split(",").sort(), plan.join("\n"));
  // Each leg keeps verify-gates' canonical order, so --only never arrives padded
  // or shuffled on either rig.
  const canonical = (l: string) => FULL.split(",").filter((g) => l.split(",").includes(g)).join(",");
  for (const leg of legs) assert.equal(leg, canonical(leg));
});

test("--print-plan without a fleet answer is a usage error, never a guessed plan", () => {
  assert.throws(
    () =>
      execFileSync("bash", [SCRIPT, "--print-plan", "--classify", "src-tauri/src/lib.rs"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    (e: { status?: number }) => e.status === 2,
  );
});
