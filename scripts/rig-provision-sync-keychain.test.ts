import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The provisioner is the one part of the unattended auto-sync run that writes a
// password to disk and creates a keychain, so its contract is a security
// contract: the password file is owner-only and holds nothing but the password,
// the keychain it makes is a dedicated one, and the user's default keychain and
// search list are LEFT ALONE — the verify run swaps those for its own duration
// and puts them back, and a provisioner that swapped them permanently would
// redirect every other credential on the machine.
//
// Driven against a recording stub for security(1) rather than the real thing:
// these assertions are about which calls the script makes, and a suite that
// created real keychains on the gate rigs would be a worse test and a worse
// neighbour.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/rig-provision-sync-keychain.sh");

/** Everything a failed run knows about itself, for the assertion that reports it. */
function detail(r: ReturnType<typeof run>): string {
  return [
    `exit ${r.status}${r.signal ? ` (signal ${r.signal})` : ""}`,
    `stdout: ${r.stdout?.trim() || "(empty)"}`,
    `stderr: ${r.stderr?.trim() || "(empty)"}`,
  ].join("\n");
}

/** A PATH whose `security` records its arguments and whose `uname` says Darwin. */
function makeStubs(dir: string, opts: { slowCat?: boolean } = {}): { bin: string; calls: () => string[] } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "security-calls.txt");
  writeFileSync(
    join(bin, "security"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(log)}\n` +
      // create-keychain is the one call with a side effect the script checks
      // for afterwards, so the stub has to leave the file behind.
      `if [[ "$1" == create-keychain ]]; then : >"\${@: -1}"; fi\n` +
      `if [[ "$1" == default-keychain ]]; then echo '    "/dev/null/login.keychain-db"'; fi\n` +
      `if [[ "$1" == delete-keychain ]]; then rm -f "\${@: -1}"; fi\n` +
      // The script feeds the password to unlock-keychain down a pipe, under
      // `set -o pipefail`. A stub that exits without reading it leaves the cat
      // ahead of it writing into a closed pipe — SIGPIPE, 141, and a script
      // that reports it could not unlock a keychain it had just created. Who
      // wins that race depends on how loaded the box is, which is why it read
      // as a different single test failing on a different rig each time. The
      // real security(1) reads its stdin, so the stub does too.
      `if [[ "$1" == unlock-keychain ]]; then cat >/dev/null; fi\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );
  // A `cat` that always loses the race to the far side of a pipe. The
  // provisioner used to feed the password to `security unlock-keychain`
  // through one, and a reader that exits before the writer's first write
  // kills `cat` with SIGPIPE — status 141, which pipefail hands to the whole
  // pipeline. On a loaded rig that was an intermittent "created it but could
  // not unlock it" against a keychain that was fine.
  if (opts.slowCat) {
    writeFileSync(
      join(bin, "cat"),
      `#!/usr/bin/env bash\nsleep 0.2\nexec /bin/cat "$@"\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    join(bin, "uname"),
    `#!/usr/bin/env bash\n[[ "\${1:-}" == -s ]] && { echo Darwin; exit 0; }\nexec /usr/bin/uname "$@"\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

// The script under test is a real entry point in scripts/, so it opens with the
// checkout-freshness guard: sourced from a detached checkout that sits behind
// origin/main, it prints its refusal and exits 1 before reaching a line this
// file has anything to say about. That is a property of the CHECKOUT the runner
// happens to be pointed at, not of the code under test — the same tree passed
// 6/6 from a branch worktree and failed five of six from the read-mostly
// primary checkout on the same machine, minutes apart. So the child gets a
// built environment rather than an inherited one: the guard waived by name, a
// PATH whose stubs cannot be reordered away, and a HOME under the fixture so
// that even a run which somehow lost the two AUTOSYNC_ variables would write
// into the temporary directory instead of the real ~/Library/Keychains.
function childEnv(dir: string, bin: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return {
    // Ahead of the inherited PATH, not instead of it: the stubs win either way,
    // and a host that keeps its coreutils somewhere unusual still finds them.
    PATH: `${bin}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
    HOME: home,
    LC_ALL: "C",
    SUBSTRATE_ALLOW_STALE_SCRIPTS: "1",
    AUTOSYNC_KEYCHAIN: join(dir, "substrate-autosync.keychain-db"),
    AUTOSYNC_KEYCHAIN_PASSWORD_FILE: join(dir, "conf/autosync-keychain-password"),
    ...extra,
  };
}

function run(dir: string, bin: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv(dir, bin, extra),
  });
}

function withDir(body: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rig-provision-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("provisioning leaves the password owner-only and free of a trailing newline", () => {
  withDir((dir) => {
    const { bin } = makeStubs(dir);
    const r = run(dir, bin);
    assert.equal(r.status, 0, detail(r));
    // Nothing on stderr is also how this file proves its own isolation: the
    // checkout guard's other outcome is a warning rather than a refusal, and a
    // warning here would mean the run was reading the checkout again.
    assert.equal(r.stderr, "", "a provisioning run that worked has nothing to say on stderr");
    const file = join(dir, "conf/autosync-keychain-password");
    const password = readFileSync(file, "utf8");
    assert.equal(password.length, 40, "the password should be 40 characters");
    assert.match(password, /^[A-Za-z0-9]{40}$/, "no newline and nothing but the password");
    assert.equal(statSync(file).mode & 0o777, 0o600, "the password file must be owner-only");
  });
});

test("provisioning does not touch the default keychain or the search list", () => {
  withDir((dir) => {
    const { bin, calls } = makeStubs(dir);
    const r = run(dir, bin);
    assert.equal(r.status, 0, detail(r));
    const made = calls();
    assert.ok(
      made.some((c) => c.startsWith("create-keychain ")),
      "it should have created the dedicated keychain",
    );
    assert.ok(
      !made.some((c) => c.startsWith("default-keychain") && c.includes(" -s ")),
      `the default keychain must be left alone, saw: ${made.join(" | ")}`,
    );
    assert.ok(
      !made.some((c) => c.startsWith("list-keychains") && c.includes(" -s ")),
      `the search list must be left alone, saw: ${made.join(" | ")}`,
    );
  });
});

test("provisioning clears the auto-lock timeout, which a twenty-minute run needs", () => {
  withDir((dir) => {
    const { bin, calls } = makeStubs(dir);
    const r = run(dir, bin);
    assert.equal(r.status, 0, detail(r));
    assert.ok(
      calls().some((c) => c.startsWith("set-keychain-settings ")),
      "a keychain that relocks after five minutes strands the run halfway through",
    );
  });
});

test("provisioning refuses to be pointed at the login keychain", () => {
  withDir((dir) => {
    const { bin, calls } = makeStubs(dir);
    const r = run(dir, bin, [], {
      AUTOSYNC_KEYCHAIN: join(dir, "login.keychain-db"),
    });
    assert.notEqual(r.status, 0, detail(r));
    assert.match(r.stderr, /refusing to touch the login keychain/, detail(r));
    assert.deepEqual(calls(), [], "it must not have run security(1) at all");
    assert.ok(!existsSync(join(dir, "conf/autosync-keychain-password")), "and must not have written a password");
  });
});

test("a second run leaves the existing password in place unless forced", () => {
  withDir((dir) => {
    const { bin } = makeStubs(dir);
    const firstRun = run(dir, bin);
    assert.equal(firstRun.status, 0, detail(firstRun));
    const file = join(dir, "conf/autosync-keychain-password");
    const first = readFileSync(file, "utf8");

    const again = run(dir, bin);
    assert.equal(again.status, 0, detail(again));
    assert.match(again.stdout, /already provisioned/, detail(again));
    assert.equal(readFileSync(file, "utf8"), first, "an accidental re-run must not orphan the keychain");

    const forced = run(dir, bin, ["--force"]);
    assert.equal(forced.status, 0, detail(forced));
    assert.notEqual(readFileSync(file, "utf8"), first, "--force should mint a new one");
  });
});

test("residue from an earlier run is replaced rather than read", () => {
  // The state a re-run actually meets on a rig: a keychain file and a password
  // file both left behind by the run before it. Unforced, the script must keep
  // them and say so; forced, it must mint over both, and neither branch may
  // depend on what the previous run happened to write.
  withDir((dir) => {
    const { bin } = makeStubs(dir);
    const keychain = join(dir, "substrate-autosync.keychain-db");
    const file = join(dir, "conf/autosync-keychain-password");
    mkdirSync(join(dir, "conf"), { recursive: true });
    writeFileSync(keychain, "");
    writeFileSync(file, "stale-password-from-a-previous-run", { mode: 0o600 });

    const kept = run(dir, bin);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /already provisioned/);
    assert.equal(readFileSync(file, "utf8"), "stale-password-from-a-previous-run");

    const forced = run(dir, bin, ["--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(readFileSync(file, "utf8"), /^[A-Za-z0-9]{40}$/, "the stale password must be gone");
    assert.ok(existsSync(keychain), "and a keychain must be there for the run to unlock");
  });
});

test("provisioning survives a password reader that is slow to reach the pipe", () => {
  // That flake, made deterministic: with a `cat` that is always late,
  // any pipeline carrying the password to a tool that exits first reports 141
  // under pipefail and the run fails with a keychain that was never wrong.
  // Feeding stdin from a redirect instead leaves nobody holding a pipe.
  withDir((dir) => {
    const { bin, calls } = makeStubs(dir, { slowCat: true });
    const r = run(dir, bin);
    assert.equal(r.status, 0, detail(r));
    assert.ok(
      calls().some((c) => c.startsWith("unlock-keychain ")),
      `it should still have unlocked the keychain, saw: ${calls().join(" | ")}`,
    );
  });
});

test("the verify run restores the keychain search list from an array", () => {
  // A search list rebuilt by splitting a string on spaces turns one path
  // containing a space into two entries that are each nothing, and leaves the
  // user's keychain configuration quietly broken after a run that passed.
  const src = readFileSync(join(ROOT, "scripts/autosync-verify.sh"), "utf8");
  assert.match(src, /KEYCHAIN_PRIOR_LIST=\(\)/, "the prior search list must be an array");
  assert.match(
    src,
    /security list-keychains -d user -s "\$\{KEYCHAIN_PRIOR_LIST\[@\]\}"/,
    "the restore must expand it with quoted [@]",
  );
});
