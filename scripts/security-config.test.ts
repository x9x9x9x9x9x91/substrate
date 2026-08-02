import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The security block's invariants (SUB-610/SUB-612). The bundle smoke lane
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
};
const sec = conf.app.security;

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

// SUB-780: the deny list is the only thing standing between a pasted
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

test("asset protocol still denies ahead of a $HOME-wide allow", () => {
  // The allow list has to stay broad (runtime vault root, external media);
  // docs/security-config.md explains why. That is only safe while deny wins.
  const scope = sec.assetProtocol?.scope;
  assert.ok(scope?.allow?.includes("$HOME/**"), "allow list no longer matches the documented shape");
  assert.ok((scope?.deny?.length ?? 0) >= DENY_MUST_INCLUDE.length, "deny list shrank");
});
