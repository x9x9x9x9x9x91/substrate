import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The security block's invariants. The bundle smoke lane
// (SMOKE_BUNDLE=1) proves the shipped CSP behaves; it is optional and slow,
// so this test holds the config shape inside the required `npm test` gate —
// a future edit that drops a load-bearing line fails here, not in a shipped DMG.
// Reasoning for every line: docs/security-config.md.

const ROOT = fileURLToPath(new URL("../", import.meta.url));

interface SecurityBlock {
  csp?: string;
  devCsp?: string;
  dangerousDisableAssetCspModification?: boolean | string[];
  assetProtocol?: { enable?: boolean; scope?: { allow?: string[]; deny?: string[] } };
}

const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
  app: { security: SecurityBlock };
  plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
};
const sec = conf.app.security;
const tauriLib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
const kindCommands = readFileSync(join(ROOT, "src-tauri/src/commands/kinds.rs"), "utf8");

function directive(csp: string, name: string): string | null {
  const hit = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  return hit ?? null;
}

test("shipped csp exists and keeps script-src locked down", () => {
  assert.ok(sec.csp, "app.security.csp is missing — the webview would run with no policy");
  const script = directive(sec.csp, "script-src");
  assert.ok(script, "csp has no script-src");
  assert.ok(script.includes("'self'"), "script-src lost 'self'");
  assert.ok(
    !script.includes("unsafe-inline") && !script.includes("unsafe-eval"),
    `script-src must never relax to inline/eval in the SHIPPED policy: ${script}`
  );
});

/** A directive's source list, minus the directive name. */
function sources(csp: string, name: string): string[] {
  const hit = directive(csp, name);
  assert.ok(hit, `csp has no ${name}`);
  return hit.split(/\s+/).slice(1);
}

// The two origins vault-resident custom-kind code is served from —
// `substrate-kind://localhost/…` on macOS/iOS, `http://substrate-kind.localhost/…`
// on Windows/Android. Both spellings of the SAME scheme; neither is optional,
// and neither is a wildcard.
const KIND_SOURCES = ["substrate-kind:", "http://substrate-kind.localhost"];

test("script-src and connect-src are EXACT lists, not merely non-empty", () => {
  // Pinned as full lists rather than `includes` checks: custom kinds mean the
  // webview now executes code the user dropped in a folder, so the set of
  // origins it may load from and talk to is the whole boundary. A widened
  // directive — a stray `blob:`, `data:`, `https:` or `*` — is exactly how
  // that code would reach something it wasn't given. Growing either list is a
  // deliberate edit here, in the same commit.
  assert.deepEqual(sources(sec.csp!, "script-src"), ["'self'", ...KIND_SOURCES]);
  assert.deepEqual(sources(sec.csp!, "connect-src"), [
    "'self'",
    ...KIND_SOURCES,
    "asset:",
    "http://asset.localhost",
    "ipc:",
    "http://ipc.localhost",
    "data:",
    "blob:",
  ]);
});

test("devCsp carries the same kind origins as the shipped policy", () => {
  // The dev policy is looser by design (`unsafe-inline`/`unsafe-eval` for the
  // Vite lane, the localhost websocket) but it must not be looser about WHERE
  // kind code comes from — otherwise a bundle works in dev and 404s in the
  // shipped app for a reason nobody can see.
  assert.deepEqual(sources(sec.devCsp!, "script-src"), [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    ...KIND_SOURCES,
  ]);
  assert.deepEqual(sources(sec.devCsp!, "connect-src"), [
    "'self'",
    ...KIND_SOURCES,
    "asset:",
    "http://asset.localhost",
    "ipc:",
    "http://ipc.localhost",
    "data:",
    "blob:",
    "ws://localhost:1420",
    "http://localhost:1420",
  ]);
});

test("custom-kind execution stays disabled on iOS", () => {
  assert.match(
    tauriLib,
    /#\[cfg\(not\(target_os = "ios"\)\)\]\s*let builder = builder\.register_uri_scheme_protocol\(kinds::SCHEME/,
    "the custom scheme must not be registered in the first iOS build"
  );
  assert.match(
    kindCommands,
    /if cfg!\(target_os = "ios"\)\s*\{\s*return Err\("custom dashboard kinds are not available on iOS yet"\.into\(\)\);/,
    "kinds_enable must explicitly refuse consent on iOS"
  );
});

test("style-src keeps 'unsafe-inline' — CodeMirror/xterm/style= all need it", () => {
  const style = directive(sec.csp!, "style-src");
  assert.ok(style, "csp has no style-src");
  assert.ok(
    style.includes("'unsafe-inline'"),
    `style-src without 'unsafe-inline' renders the editor unstyled (SUB-610): ${style}`
  );
});

test("Tauri's style-src nonce injection stays disabled, and ONLY style-src", () => {
  const flag = sec.dangerousDisableAssetCspModification;
  // A bundle-time nonce voids 'unsafe-inline' per the CSP spec, so without
  // this opt-out the line above is dead letter in the packaged app — the
  // exact 0.16.0 ship-break. `true` would also work but would turn off
  // script hashing with it; the array keeps script-src under Tauri's control.
  assert.ok(Array.isArray(flag), "dangerousDisableAssetCspModification must be a directive list");
  assert.deepEqual(
    [...flag].sort(),
    ["style-src"],
    "the opt-out must cover style-src and nothing else — widening it weakens script-src hashing"
  );
});

// The deny list is the only thing standing between a pasted
// `![[~/.ssh/id_ed25519]]` and the webview reading it, so every store is
// pinned by exact string here — see docs/security-config.md for why the
// credential dirs are named in full rather than globbed as `$HOME/.claude*`.
const DENY_MUST_INCLUDE = [
  "$HOME/.ssh/**",
  "$HOME/.gnupg/**",
  "$HOME/.aws/**",
  "$HOME/.config/**",
  "$HOME/.docker/**",
  "$HOME/.kube/**",
  "$HOME/.claude/**",
  "$HOME/.codex/**",
  // The updater signing key — its compromise signs code for every
  // install, so it's a credential store like .ssh
  "$HOME/.tauri/**",
  "$HOME/.npmrc",
  "$HOME/.netrc",
  "$HOME/.zsh_history",
  "$HOME/.bash_history",
  "$HOME/.gitconfig",
  "$HOME/.git-credentials",
  "$HOME/.cargo/credentials.toml",
  "$HOME/Library/Keychains/**",
  "$HOME/Library/Cookies/**",
  "$HOME/Library/Messages/**",
  "$HOME/Library/Mail/**",
  "$HOME/Library/Safari/**",
  "$HOME/Library/Application Support/**",
  "$HOME/Library/Containers/**",
  "$HOME/Library/Group Containers/**",
  "$HOME/Library/Mobile Documents/**",
  "$HOME/**/.env",
  "$HOME/**/.env.*",
  "$HOME/**/.git/**",
];

test("asset-protocol deny list keeps every credential store pinned", () => {
  const deny = sec.assetProtocol?.scope?.deny;
  assert.ok(Array.isArray(deny), "app.security.assetProtocol.scope.deny is missing");
  for (const entry of DENY_MUST_INCLUDE) {
    assert.ok(deny.includes(entry), `deny list dropped ${entry} — that path becomes readable`);
  }
});

test("deny entries name directories in full — no prefix-globbed dir names", () => {
  // A `$HOME/.claude*/**`-style entry would match (glob's `*` spans partial
  // segments), but its meaning drifts as new `.claude*` dirs appear, and a
  // deny rule nobody can audit is not a deny rule. `**` for depth and a
  // trailing `.env.*` filename glob are the deliberate exceptions.
  const deny = sec.assetProtocol!.scope!.deny!;
  for (const entry of deny) {
    const dirs = entry.split("/").slice(0, -1);
    for (const segment of dirs) {
      assert.ok(
        segment === "**" || !segment.includes("*"),
        `${entry}: directory segment '${segment}' is prefix-globbed — name it in full`
      );
    }
  }
});

test("updater config keeps its pubkey pin and https GitHub endpoint (SUB-806)", () => {
  // The pubkey is the whole trust model: the app refuses any update the
  // matching private key (~/.tauri/substrate-updater.key, never committed)
  // didn't sign. Pinned as the LITERAL string — a length/shape check would
  // wave any attacker-generated minisign key through; this test is the
  // only mechanical defence against a
  // re-pointed trust anchor. Rotating the key legitimately means updating
  // this constant in the same commit, deliberately.
  const PINNED_PUBKEY =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU5N0YzNjlCOTJBREE2MkEKUldRcXBxMlNtelovNmNNazdwU3Rsb1pNRHc2T0tYTlFxalNPTDlVTldTMStwRjBrQ0VVMW5QQysK";
  const updater = conf.plugins?.updater;
  assert.equal(
    updater?.pubkey,
    PINNED_PUBKEY,
    "plugins.updater.pubkey is missing or differs from the pinned key — a swap re-points update trust"
  );
  assert.deepEqual(
    updater?.endpoints,
    ["https://github.com/x9x9x9x9x9x91/substrate/releases/latest/download/latest.json"],
    "updater endpoints changed — the update channel moved or grew an extra source"
  );
});

test("asset protocol still denies ahead of a $HOME-wide allow", () => {
  // The allow list has to stay broad (runtime vault root, external media);
  // docs/security-config.md explains why. That is only safe while deny wins.
  const scope = sec.assetProtocol?.scope;
  assert.ok(scope?.allow?.includes("$HOME/**"), "allow list no longer matches the documented shape");
  assert.ok((scope?.deny?.length ?? 0) >= DENY_MUST_INCLUDE.length, "deny list shrank");
});
