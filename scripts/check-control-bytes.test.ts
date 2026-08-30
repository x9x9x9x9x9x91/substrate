/**
 * The gate itself (the tracked tree carries no raw control bytes) plus the two
 * decisions it rests on: which files count as text, and what counts as a
 * control byte. Both are cheap to assert here and expensive to discover from
 * a file that has quietly gone binary — the failure mode is silence, not an
 * error, so nothing downstream will report it for you.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BINARY_EXTENSIONS,
  escapeFor,
  findControlBytes,
  isBinaryPath,
  scanTree,
  trackedFiles,
} from "./check-control-bytes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-control-bytes.ts");

/** A throwaway git repo holding `files`, committed so ls-files sees them. */
function withRepo(files: Record<string, string | Uint8Array>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "control-bytes-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    for (const [path, body] of Object.entries(files)) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the tracked tree carries no raw control bytes", () => {
  const hits = scanTree(ROOT);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.column}: 0x${h.byte.toString(16)}`),
    [],
  );
});

test("a NUL is reported with the file, line, column and the escape to use", () => {
  const src = "# heading\n\nprose with a \0 in it\n";
  const hits = findControlBytes("docs/x.md", new TextEncoder().encode(src));
  assert.deepEqual(hits, [
    { file: "docs/x.md", line: 3, column: 14, byte: 0x00, escape: "\\0" },
  ]);
});

test("tab and newline are text; carriage return, ESC and DEL are not", () => {
  const bytes = Uint8Array.from([0x61, 0x09, 0x62, 0x0a, 0x0d, 0x1b, 0x7f]);
  assert.deepEqual(
    findControlBytes("a.ts", bytes).map((h) => h.escape),
    ["\\r", "\\x1b", "\\x7f"],
  );
  assert.equal(escapeFor(0x00), "\\0");
  assert.equal(escapeFor(0x03), "\\x03");
});

test("declared binary extensions are skipped, unknown ones are scanned", () => {
  assert.ok(isBinaryPath("docs/img/shot.PNG"), "the extension match is case-insensitive");
  assert.ok(isBinaryPath("site/inter.woff2"));
  assert.ok(!isBinaryPath("scripts/x.ts"));
  assert.ok(!isBinaryPath("LICENSE"), "an extensionless file is text");
  assert.ok(!isBinaryPath("fixtures/blob.pcm"), "an undeclared format fails loudly, not silently");
  assert.ok(BINARY_EXTENSIONS.has(".png"));
});

test("the scan reads tracked files only, binary assets excepted", () => {
  withRepo(
    {
      "docs/a.md": "clean\n",
      "docs/b.md": "a \0 here\n",
      "img/c.png": Uint8Array.from([0x89, 0x50, 0x00, 0x01]),
    },
    (dir) => {
      writeFileSync(join(dir, "untracked.md"), "a \0 nobody committed\n");
      assert.ok(trackedFiles(dir).includes("docs/b.md"));
      assert.deepEqual(
        scanTree(dir).map((h) => h.file),
        ["docs/b.md"],
      );
    },
  );
});

test("the CLI exits 1 naming the byte, and 0 on a clean tree", () => {
  withRepo({ "docs/b.md": "line one\nline \x1b two\n" }, (dir) => {
    const bad = spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /docs\/b\.md:2:6/);
    assert.match(bad.stderr, /0x1b/);
    assert.match(bad.stderr, /BINARY_EXTENSIONS/);
  });
  withRepo({ "docs/a.md": "clean\n" }, (dir) => {
    const ok = spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /no raw control bytes/);
  });
});

// ── Wired into a leg, not just into package.json ───────────────────────────
// The guard shipped with a script name and nothing calling it: for two weeks
// `npm run check:bytes` ran only when someone remembered a fault whose whole
// signature is that nobody notices it. It now rides the `lint` leg, first,
// because it costs a second against eslint's minute and because a tree that
// has gone binary is worth hearing about before a style verdict. What is
// pinned here is the wiring — that the chain names the guard, that the named
// invocation really reds on a NUL, and that the leg still runs the chain.

test("the lint leg runs the control-byte guard, and the guard reds on a NUL", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const segments = pkg.scripts.lint.split("&&").map((s) => s.trim());
  const guard = segments.find((s) => s.includes("check-control-bytes"));
  assert.ok(guard, `the lint chain no longer invokes the guard: ${pkg.scripts.lint}`);
  assert.ok(
    segments.some((s) => s.startsWith("eslint")),
    "chaining the guard must not have cost the leg its eslint run",
  );

  // The segment as package.json spells it, run against a tree with one NUL:
  // a name in the chain that does not exit nonzero is the same silence the
  // guard exists to end.
  withRepo({ "docs/b.md": "a \0 here\n" }, (dir) => {
    const red = spawnSync("bash", ["-c", `${guard} "$1"`, "lint-chain", dir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /docs\/b\.md/);
  });

  // …and the leg is the chain: verify-gates.sh runs the npm script verbatim,
  // so editing package.json is what puts the guard on every battery that
  // carries `lint`.
  const legs = readFileSync(join(ROOT, "scripts/verify-gates.sh"), "utf8");
  assert.match(legs, /lint\)\s+run_gate lint\s+npm run lint/);
});
