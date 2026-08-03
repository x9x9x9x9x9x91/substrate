import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LIB = join(ROOT, "scripts/lib/release-source.sh");

type Rig = { repo: string; bin: string; commit: string };

function makeRig(dir: string, opts: { tag?: "annotated" | "lightweight" | "none"; rustc?: string } = {}): Rig {
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(repo, "tracked.txt"), "release source\n");
  writeFileSync(
    join(repo, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\n',
  );
  writeFileSync(join(bin, "rustc"), `#!/usr/bin/env bash\necho 'rustc ${opts.rustc ?? "1.97.1"} (test)'\n`);
  chmodSync(join(bin, "rustc"), 0o755);

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.test");
  git("add", "-A");
  git("commit", "-qm", "release source");
  const commit = git("rev-parse", "HEAD").trim();
  if ((opts.tag ?? "annotated") === "annotated") git("tag", "-a", "v1.2.3", "-m", "Release 1.2.3");
  if (opts.tag === "lightweight") git("tag", "v1.2.3");
  return { repo, bin, commit };
}

function run(rig: Rig, version = "1.2.3") {
  return spawnSync(
    "bash",
    ["-c", '. "$1"; release_source_facts "$2" "$3"', "release-source-test", LIB, rig.repo, version],
    {
      cwd: rig.repo,
      env: { ...process.env, PATH: `${rig.bin}:${process.env.PATH}` },
      encoding: "utf8",
    },
  );
}

function withRig(
  fn: (rig: Rig) => void,
  opts: { tag?: "annotated" | "lightweight" | "none"; rustc?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "substrate-release-source-"));
  try {
    fn(makeRig(dir, opts));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts a clean exact annotated tag and reports source provenance", () => {
  withRig((rig) => {
    const result = run(rig);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), `${rig.commit}\tv1.2.3\trustc 1.97.1 (test)`);
  });
});

test("refuses tracked and untracked working-tree changes", () => {
  withRig((rig) => {
    writeFileSync(join(rig.repo, "tracked.txt"), "changed\n");
    writeFileSync(join(rig.repo, "untracked.txt"), "new\n");
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /working tree is dirty/);
    assert.match(result.stderr, /tracked\.txt/);
    assert.match(result.stderr, /untracked\.txt/);
  });
});

test("refuses a missing release tag", () => {
  withRig((rig) => {
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /annotated tag v1\.2\.3 does not exist/);
  }, { tag: "none" });
});

test("refuses a lightweight release tag", () => {
  withRig((rig) => {
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /v1\.2\.3 is lightweight/);
  }, { tag: "lightweight" });
});

test("refuses when the release tag does not point at HEAD", () => {
  withRig((rig) => {
    execFileSync("git", ["-C", rig.repo, "commit", "-qm", "later", "--allow-empty"]);
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HEAD .* is not v1\.2\.3/);
  });
});

test("refuses a rustc that does not match the exact repository pin", () => {
  withRig((rig) => {
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rustc 1\.96\.0 is active.*pins 1\.97\.1/);
  }, { rustc: "1.96.0" });
});

test("refuses a repository with no rust-toolchain.toml", () => {
  withRig((rig) => {
    const git = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" });
    git("rm", "-q", "rust-toolchain.toml");
    git("commit", "-qm", "drop the toolchain pin");
    git("tag", "-f", "-a", "v1.2.3", "-m", "Release 1.2.3");
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rust-toolchain\.toml is missing/);
  });
});

test("refuses a toolchain channel that is not an exact x.y.z pin", () => {
  withRig((rig) => {
    const git = (...args: string[]) => execFileSync("git", ["-C", rig.repo, ...args], { encoding: "utf8" });
    writeFileSync(join(rig.repo, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\nprofile = "minimal"\n');
    git("commit", "-aqm", "float the toolchain channel");
    git("tag", "-f", "-a", "v1.2.3", "-m", "Release 1.2.3");
    const result = run(rig);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must pin an exact x\.y\.z channel \(got 'stable'\)/);
  });
});

test("the repository pin is exact and every Rust CI image matches it", () => {
  const toolchain = readFileSync(join(ROOT, "rust-toolchain.toml"), "utf8");
  const channel = toolchain.match(/^channel = "([^"]+)"$/m)?.[1];
  assert.match(channel ?? "", /^\d+\.\d+\.\d+$/);

  const ci = readFileSync(join(ROOT, ".gitlab-ci.yml"), "utf8");
  const images = [...ci.matchAll(/^\s*image: (rust:[^\s]+)$/gm)].map((match) => match[1]);
  assert.ok(images.length > 0, "expected at least one Rust CI image");
  assert.deepEqual(new Set(images), new Set([`rust:${channel}-bookworm`]));
});

