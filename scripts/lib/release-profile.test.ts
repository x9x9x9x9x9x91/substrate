import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// What the surrounding environment is and is not allowed to decide about a
// release build.
//
// Each case here is a hole that was open: a shell that still had
// SUBSTRATE_PUBLIC=1 in it turned a plain `release-macos.sh` into a full
// backend wrapped around a stripped frontend — with every signing, path-leak
// and artifact gate passing, because each of them was looking at a binary that
// really was the full one. An inherited CARGO_TARGET_DIR did the same to the
// two profiles' separate build directories, and two DMGs named after the
// version alone cannot be told apart at all once they leave those directories.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LIB = fileURLToPath(new URL("./release-profile.sh", import.meta.url));

/** Source the library with a given environment and read back what it derived. */
function derive(profile: string, env: Record<string, string>): Record<string, string> {
  const script = `
    . ${JSON.stringify(LIB)}
    release_profile_export ${JSON.stringify(profile)}
    echo "public=\${SUBSTRATE_PUBLIC-<unset>}"
    echo "target=$(release_target_dir ${JSON.stringify(profile)})"
    echo "dmg=$(release_dmg_name ${JSON.stringify(profile)} 9.9.9)"
    # exported, not merely set: the build's two halves are separate processes
    echo "seen_by_child=$(env | grep '^SUBSTRATE_PUBLIC=' || echo '<unset>')"
  `;
  const out = execFileSync("bash", ["-uo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

test("a public build sets the frontend switch, a full build clears an inherited one", () => {
  assert.equal(derive("public", {}).public, "1");
  assert.equal(derive("public", {}).seen_by_child, "SUBSTRATE_PUBLIC=1");

  assert.equal(derive("full", {}).public, "<unset>");
  const poisoned = derive("full", { SUBSTRATE_PUBLIC: "1" });
  assert.equal(poisoned.public, "<unset>", "an inherited SUBSTRATE_PUBLIC=1 must not survive into a full build");
  assert.equal(poisoned.seen_by_child, "<unset>", "and must not reach the child process vite runs in");
});

test("the profile's target directory survives an inherited CARGO_TARGET_DIR", () => {
  const dflt = "/private/var/tmp/substrate-release-target";
  assert.equal(derive("full", {}).target, dflt);
  assert.equal(derive("public", {}).target, `${dflt}-public`);

  const outer = { CARGO_TARGET_DIR: "/tmp/someone-elses-target" };
  assert.equal(derive("full", outer).target, "/tmp/someone-elses-target");
  assert.equal(
    derive("public", outer).target,
    "/tmp/someone-elses-target-public",
    "the two profiles must not compile into one directory, whoever set the base",
  );

  // A path cargo itself accepts. Suffixed as-is it names a sibling directory
  // called "-public", which is not the public variant of anything.
  const slashed = { CARGO_TARGET_DIR: "/tmp/someone-elses-target/" };
  assert.equal(derive("full", slashed).target, "/tmp/someone-elses-target");
  assert.equal(derive("public", slashed).target, "/tmp/someone-elses-target-public");
});

test("the public DMG is named as the public one", () => {
  assert.equal(derive("full", {}).dmg, "Substrate_9.9.9_aarch64.dmg");
  assert.equal(derive("public", {}).dmg, "Substrate_9.9.9_aarch64-public.dmg");
});

test("the release script derives all three through this library, not by hand", () => {
  // The holes above were each written inline once already; a re-inlined copy
  // is how they come back.
  const src = readFileSync(`${ROOT}scripts/release-macos.sh`, "utf8");
  assert.match(src, /\. "\$ROOT\/scripts\/lib\/release-profile\.sh"/);
  for (const fn of ["release_profile_export", "release_target_dir", "release_dmg_name"]) {
    assert.ok(src.includes(`${fn} `) || src.includes(`${fn}(`), `release-macos.sh never calls ${fn}`);
  }
  assert.doesNotMatch(
    src,
    /export SUBSTRATE_PUBLIC=/,
    "the frontend switch is set in the library, where clearing it is not optional",
  );
});

test("nothing downstream of the flags reassigns PROFILE", () => {
  // It was reused once, for the embedded provisioning profile's path, inside a
  // block that runs on every release. From there on the script believed it was
  // building a profile named ".../embedded.provisionprofile": the fenced-artifact
  // probe was handed that as --profile and exited 2 on BOTH builds, the guard
  // keeping a public build off the shared update channel quietly went false, and
  // the sha sidecar and the closing summary named a path where the profile goes.
  // Every reader below the parse trusts this one variable, so the name is spoken
  // for from the parse onwards.
  const lines = readFileSync(`${ROOT}scripts/release-macos.sh`, "utf8").split("\n");
  const parsed = lines.findIndex((l) => l.includes("release_profile_export"));
  assert.ok(parsed > 0, "the release script no longer derives the profile through the library");
  const reassigned = lines
    .map((line, i) => [i + 1, line] as const)
    .filter(([i, line]) => i > parsed + 1 && /(^|[^A-Za-z0-9_])PROFILE=/.test(line))
    .map(([i, line]) => `${i}: ${line.trim()}`);
  assert.deepEqual(reassigned, [], "PROFILE is the build profile from the arg parse on — give this one another name");
});
