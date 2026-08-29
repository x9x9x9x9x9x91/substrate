import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TAURI = join(ROOT, "src-tauri");
const WRAPPER = join(ROOT, "scripts/lib/cargo-target.sh");
const hasCargo = spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;

function cargoTarget(cwd: string, target: string, manifestPath?: string): string {
  const args = ["metadata", "--no-deps", "--format-version", "1"];
  if (manifestPath) args.push("--manifest-path", manifestPath);
  const metadata = JSON.parse(
    execFileSync("cargo", args, {
      cwd,
      env: { ...process.env, CARGO_TARGET_DIR: target },
      encoding: "utf8",
    }),
  ) as { target_directory: string };
  return metadata.target_directory;
}

test("the shared target default is portable and explicit overrides win (SUB-987)", () => {
  const fakeHome = join(tmpdir(), "substrate-cargo-home");
  const defaultTarget = execFileSync(
    "bash",
    [WRAPPER, "sh", "-c", 'printf "%s" "$CARGO_TARGET_DIR"'],
    // NO_CARGO_PIN: this call is about the exported default, and a fake HOME
    // must not be what gets written into the real checkout's config.
    {
      env: { ...process.env, HOME: fakeHome, CARGO_TARGET_DIR: "", SUBSTRATE_NO_CARGO_PIN: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(defaultTarget, join(fakeHome, ".cache/substrate-cargo-target"));

  const override = join(tmpdir(), "substrate-cargo-override");
  const overriddenTarget = execFileSync(
    "bash",
    [WRAPPER, "sh", "-c", 'printf "%s" "$CARGO_TARGET_DIR"'],
    { env: { ...process.env, CARGO_TARGET_DIR: override }, encoding: "utf8" },
  );
  assert.equal(overriddenTarget, override);

  // A .cargo/config.toml now EXISTS locally (the pin below writes it), but it
  // must never be trackable: cargo expands neither ~ nor $HOME there, so a
  // committed one would hand every clone this machine's absolute path.
  assert.equal(
    spawnSync("git", ["check-ignore", "-q", ".cargo/config.toml"], { cwd: ROOT }).status,
    0,
    ".cargo/config.toml must stay gitignored",
  );
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts.tauri, "bash scripts/lib/cargo-target.sh tauri");
});

test(
  "repo-root and src-tauri Cargo contexts share the exported target (SUB-337)",
  { skip: hasCargo ? false : "cargo is not installed" },
  () => {
    // Tauri's Xcode phase invokes Cargo from the npm package root with an
    // explicit manifest, while the outer CLI resolves its library path from
    // cargo metadata in src-tauri. Both inherit the wrapper's exported target.
    const sharedTarget = join(tmpdir(), "substrate-cargo-target-contract");
    const xcodePhaseTarget = cargoTarget(ROOT, sharedTarget, join(TAURI, "Cargo.toml"));
    const outerCliTarget = cargoTarget(TAURI, sharedTarget);

    assert.equal(xcodePhaseTarget, outerCliTarget);
    assert.equal(outerCliTarget, sharedTarget);
  },
);

test(
  "pinning redirects a build started outside the wrappers (SUB-1694)",
  { skip: hasCargo ? false : "cargo is not installed" },
  () => {
    // The measured bypass: a bare `cargo build` in a worktree ignores the
    // wrapper's exported default and writes a private src-tauri/target. The
    // generated config is what closes it, so assert cargo's own resolution —
    // against the wrapper's answer, not a hardcoded path, because a gate run
    // sets CARGO_TARGET_DIR and the pin has to honour that override too.
    const config = join(ROOT, ".cargo/config.toml");
    const before = existsSync(config) ? readFileSync(config, "utf8") : null;
    // A gate run exports CARGO_TARGET_DIR; the pin is about the machine
    // DEFAULT, so every step here is measured with that override stripped.
    const noOverride = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "CARGO_TARGET_DIR"),
    ) as NodeJS.ProcessEnv;
    try {
      const shared = execFileSync(
        "bash",
        [WRAPPER, "sh", "-c", 'printf "%s" "$CARGO_TARGET_DIR"'],
        { env: { ...noOverride, SUBSTRATE_NO_CARGO_PIN: "1" }, encoding: "utf8" },
      );
      execFileSync("bash", [WRAPPER, "--pin"], { env: noOverride, encoding: "utf8" });
      assert.match(readFileSync(config, "utf8"), /^\[build\]$/m);

      const bare = JSON.parse(
        execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
          cwd: TAURI,
          env: noOverride,
          encoding: "utf8",
        }),
      ) as { target_directory: string };
      assert.notEqual(bare.target_directory, join(TAURI, "target"));
      assert.equal(bare.target_directory, shared);

      // An explicit override still beats the config file, which is what keeps
      // CI and the QA rigs on their own caches.
      const override = join(tmpdir(), "substrate-cargo-override-pin");
      assert.equal(cargoTarget(TAURI, override), override);
    } finally {
      if (before === null) rmSync(config, { force: true });
      else writeFileSync(config, before);
    }
  },
);

test("the generated config is left alone when an operator wrote their own (SUB-1694)", () => {
  // Only files carrying the generator's marker are ours to rewrite; a
  // hand-written config keeps whatever the operator put in it.
  const sandbox = mkdtempSync(join(tmpdir(), "substrate-pin-"));
  mkdirSync(join(sandbox, "scripts/lib"), { recursive: true });
  mkdirSync(join(sandbox, "src-tauri"), { recursive: true });
  mkdirSync(join(sandbox, ".cargo"), { recursive: true });
  writeFileSync(join(sandbox, ".git"), "gitdir: /nowhere\n");
  writeFileSync(join(sandbox, "src-tauri/Cargo.toml"), "");
  copyFileSync(WRAPPER, join(sandbox, "scripts/lib/cargo-target.sh"));
  const mine = "[build]\ntarget-dir = \"/tmp/operator-choice\"\n";
  writeFileSync(join(sandbox, ".cargo/config.toml"), mine);

  execFileSync("bash", [join(sandbox, "scripts/lib/cargo-target.sh"), "--pin"], {
    encoding: "utf8",
  });
  assert.equal(readFileSync(join(sandbox, ".cargo/config.toml"), "utf8"), mine);
  rmSync(sandbox, { recursive: true, force: true });
});
