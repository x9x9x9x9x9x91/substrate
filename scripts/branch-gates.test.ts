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

const FULL = "tsc,test,cargo,ios,e2e,lint";

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

test("a Rust diff runs cargo+ios and keeps `test` for the TS↔Rust contract suites", () => {
  assert.equal(gatesFor("src-tauri/src/commands/voice.rs"), "test,cargo,ios");
});

test("a scripts diff runs tsc/test/lint (tsconfig includes scripts/)", () => {
  assert.equal(gatesFor("scripts/append-row.ts"), "tsc,test,lint");
});

test("an e2e spec runs e2e+lint — specs sit outside tsc's include", () => {
  assert.equal(gatesFor("e2e/palette.spec.ts"), "e2e,lint");
  assert.equal(gatesFor("playwright.config.ts"), "e2e,lint");
});

test("tiers union across files; src + Rust together is the full six", () => {
  assert.equal(gatesFor("src/lib/query.ts", "src-tauri/src/lib.rs"), FULL);
});

test("markdown that is DATA classifies by its tree, not as prose", () => {
  // The seeded vault is include_str!'d and asserted by Rust tests...
  assert.equal(gatesFor("src-tauri/src/seed/welcome.md"), "test,cargo,ios");
  assert.equal(gatesFor("src-tauri/src/seed/revisions/AGENTS.md"), "test,cargo,ios");
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

test("build config and gate infrastructure force the full six", () => {
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

test("an unclassifiable path is conservative: full six", () => {
  assert.equal(gatesFor("rust-toolchain.toml"), FULL);
  assert.equal(gatesFor("design/options/sketch.md"), FULL);
});

test("the subset is emitted in verify-gates' canonical gate order", () => {
  // Union of scripts (tsc,test,lint) and e2e (e2e,lint) tiers — the output
  // must interleave in canonical order, not concatenate per-tier.
  assert.equal(gatesFor("scripts/append-row.ts", "e2e/palette.spec.ts"), "tsc,test,e2e,lint");
});
