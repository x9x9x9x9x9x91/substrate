# Security configuration

Why `src-tauri/tauri.conf.json`'s `app.security` block looks the way it does.
JSON takes no comments, so the reasoning lives here — change the config, change
this file. Filed under SUB-427 (pre-public hardening pass).

The threat model this serves is in [SECURITY.md](../SECURITY.md): the webview is
the boundary, and a note is untrusted content that can arrive by sync or import.

## Content-Security-Policy

`csp` was `null` — meaning Tauri shipped no policy at all, so any HTML a note
could get into the DOM could pull and run a remote script. The policy below is
derived from what the app actually does, not from a template; each allowance has
a call site.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' asset: http://asset.localhost data: blob:;
media-src 'self' asset: http://asset.localhost data: blob:;
connect-src 'self' asset: http://asset.localhost ipc: http://ipc.localhost data: blob:;
worker-src 'self' blob:; object-src 'none'; base-uri 'self';
frame-src 'none'; frame-ancestors 'none'; form-action 'none'
```

- **`script-src 'self'`** — no `'unsafe-inline'`, no `'unsafe-eval'`, no remote
  origin. This is the directive that matters: it is what stops a crafted note
  from executing anything.
- **`style-src 'unsafe-inline'`** — three things depend on it: React
  `style={{…}}` attributes in 64 places (measured attributes, panel heights,
  grid columns — there is no `style-src-attr` here, so attributes fall back
  to this directive, where nonces can never apply), CodeMirror's base theme
  and syntax-highlight classes (runtime `<style>` elements via `style-mod`),
  and xterm's four runtime `<style>` elements in the terminal HUD. Inline
  styles are a far weaker vector than inline script, and removing them is a
  refactor, not a security fix. Worth revisiting; not worth blocking the
  pass on.
- **`dangerousDisableAssetCspModification: ["style-src"]`** — despite the
  name, this is what makes the line above *actually hold* in the shipped
  bundle. At build time Tauri appends a per-response nonce to `style-src`,
  and the CSP spec says a directive containing a nonce **ignores**
  `'unsafe-inline'`. So the packaged app (and only the packaged app — dev
  and e2e never see the nonce) silently dropped every one of those styles:
  CodeMirror rendered as an unstyled focusable box and every `style=`
  attribute was dead (SUB-610, 0.16.0). Scoping the opt-out to `style-src`
  alone keeps Tauri's script hashing on `script-src`, which is the directive
  doing the security work. The real-app smoke lane (private repo) is the
  regression net (SUB-612) — it runs the real bundle and fails if runtime
  styles stop applying, so a future edit to this block can't ship blind
  again.
- **`img-src` / `media-src` with `asset:` and `http://asset.localhost`** — the
  two origins `convertFileSrc` produces (`src/lib/assets.ts:24` for audio,
  `:90` for images). macOS uses the `http://asset.localhost` form; the `asset:`
  scheme is kept for the other platforms and for older webviews.
- **`data:`** — three inline `url('data:image/svg+xml…')` icons in
  `src/styles.css`, plus data-URI fonts.
- **`blob:`** — `URL.createObjectURL` in `src/lib/export.ts:15` (file export)
  and `src/lib/assets.ts:71`/`:275` (asset previews).
- **`connect-src`** — `ipc:` / `http://ipc.localhost` are Tauri's command
  channel; the asset origins are there because waveform peaks `fetch()` the
  asset URL (`src/lib/assets.ts:153`). No remote origin is allowed: every
  outbound HTTP request the app makes goes through Rust (`src-tauri/src/net.rs`),
  where the SSRF guard can see it. Two do: link capture reads a page's title
  (`fetch_url_meta`), and the finance surfaces read one USD→EUR rate from
  frankfurter (`fetch_usd_eur`, command `fx_usd_eur` — SUB-667).
- **`object-src 'none'` / `frame-src 'none'` / `frame-ancestors 'none'` /
  `form-action 'none'`** — the app has no `<iframe>`, `<object>`, or `<form>`
  submission anywhere. Denying them costs nothing and closes three classes of
  injection.

`devCsp` is the same policy plus what Vite's dev server needs and nothing else:
`'unsafe-inline' 'unsafe-eval'` in `script-src` for the dev transform, and
`ws://localhost:1420 http://localhost:1420` in `connect-src` for HMR. These
relaxations exist only in `tauri dev`; the shipped bundle uses `csp`.

That port is hardcoded and coupled to `SUBSTRATE_DEV_PORT` in `vite.config.ts`
— JSON has no substitution, so the CSP cannot follow an override. Running the
dev server on another port (the smoke lane, parallel worktrees) only costs HMR:
the page loads, live reload goes quiet. Keep the two in step when 1420 changes.

## Asset protocol scope

The scope is broad on purpose, and that is a real tradeoff rather than an
oversight:

```
allow: $HOME/**, /Volumes/**, /tmp/**, /private/tmp/**
```

Two documented features defeat a tight allow list:

1. **The vault root is chosen at runtime.** `~/Vault` is only a default
   (`src-tauri/src/lib.rs:1569`); `VAULT_DIR` overrides it
   (`:1576`). A static allow list cannot name a directory the user picks after
   the binary is built.
2. **Link-in-place embeds take absolute paths.** `![[/Volumes/audio/master.wav]]`
   and `![[~/Music/mixdown.flac]]` are documented, supported syntax
   (`docs/vault-format.md:182-195`) that resolves through `Engine::asset_info`
   (`src-tauri/src/vault.rs:2341`). Producers keep sample libraries on external
   volumes; narrowing to media folders would silently break real notes.

`/tmp/**` and `/private/tmp/**` stay so scratch vaults in tests and e2e work
(`/private/tmp` is what macOS actually resolves `/tmp` to).

So the hardening here is a **deny list**, which Tauri evaluates ahead of the
allow list (`tauri-utils` `FsScope`): credential stores, shell history, and the
app-private corners of `~/Library` can never be reached through an asset URL,
no matter what path a note asks for.

`$HOME/Library` is denied *selectively* — Keychains, Cookies, Messages, Mail,
Safari, Application Support, Containers, Group Containers, Mobile Documents —
rather than wholesale, so the rest of `~/Library` stays reachable.

`~/Library/Mobile Documents` was left allowed until SUB-780 because it is where
an iCloud-synced vault lives. It is denied now: the same directory holds every
other app's iCloud container (Notes, Keynote, 1Password's sync folder), and a
note is untrusted input. **Known cost:** a vault kept inside iCloud Drive can no
longer render `![[...]]` embeds through the asset protocol. If that vault layout
matters, the fix is a runtime allow entry for the live vault root, not
re-opening the whole directory.

The agent-CLI credential-store entries (`.claude`, `.codex`,
`.cargo/credentials.toml`, and the rest of the list in `tauri.conf.json`) are
concrete paths rather than a `$HOME/.claude*/**` wildcard. The wildcard would in fact match —
Tauri's `FsScope` runs the `glob` crate with `require_literal_separator: true`
(`tauri-2.11.5/src/scope/fs.rs:235`), so `*` spans partial segments but never a
`/`, and `requireLiteralLeadingDot: false` lets it reach dotted names. Concrete
paths are still preferred here: a deny entry is a security claim, and one that
silently changes meaning as new `.claude*`-shaped directories appear is a claim
nobody can audit.

### What this does not fix

The scope still permits reading any ordinary file under `$HOME` into an
`<img>`/`<audio>` element. Given the CSP above there is no channel to send the
bytes anywhere, so the residual risk is "a malicious note can display a file you
already have" — annoying, not exfiltration. Closing it properly means moving
asset resolution behind an IPC command that checks paths against the live vault
root plus a user-approved external-media list. That is a feature, not a config
change, and it is noted in SECURITY.md as a known limitation.
