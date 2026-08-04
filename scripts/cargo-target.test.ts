import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
    { env: { ...process.env, HOME: fakeHome, CARGO_TARGET_DIR: "" }, encoding: "utf8" },
  );
  assert.equal(defaultTarget, join(fakeHome, ".cache/substrate-cargo-target"));

  const override = join(tmpdir(), "substrate-cargo-override");
  const overriddenTarget = execFileSync(
    "bash",
    [WRAPPER, "sh", "-c", 'printf "%s" "$CARGO_TARGET_DIR"'],
    { env: { ...process.env, CARGO_TARGET_DIR: override }, encoding: "utf8" },
  );
  assert.equal(overriddenTarget, override);

  assert.equal(existsSync(join(ROOT, ".cargo/config.toml")), false);
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
