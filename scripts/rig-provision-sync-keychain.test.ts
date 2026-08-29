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

/** A PATH whose `security` records its arguments and whose `uname` says Darwin. */
function makeStubs(dir: string): { bin: string; calls: () => string[] } {
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
      `exit 0\n`,
    { mode: 0o755 },
  );
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

function run(dir: string, bin: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AUTOSYNC_KEYCHAIN: join(dir, "substrate-autosync.keychain-db"),
      AUTOSYNC_KEYCHAIN_PASSWORD_FILE: join(dir, "conf/autosync-keychain-password"),
      ...extra,
    },
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
    assert.equal(r.status, 0, r.stderr);
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
    assert.equal(run(dir, bin).status, 0);
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
    assert.equal(run(dir, bin).status, 0);
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
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to touch the login keychain/);
    assert.deepEqual(calls(), [], "it must not have run security(1) at all");
    assert.ok(!existsSync(join(dir, "conf/autosync-keychain-password")), "and must not have written a password");
  });
});

test("a second run leaves the existing password in place unless forced", () => {
  withDir((dir) => {
    const { bin } = makeStubs(dir);
    assert.equal(run(dir, bin).status, 0);
    const file = join(dir, "conf/autosync-keychain-password");
    const first = readFileSync(file, "utf8");

    const again = run(dir, bin);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already provisioned/);
    assert.equal(readFileSync(file, "utf8"), first, "an accidental re-run must not orphan the keychain");

    const forced = run(dir, bin, ["--force"]);
    assert.equal(forced.status, 0);
    assert.notEqual(readFileSync(file, "utf8"), first, "--force should mint a new one");
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
