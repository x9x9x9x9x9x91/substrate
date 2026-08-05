# Security configuration

Why `src-tauri/tauri.conf.json`'s `app.security` block looks the way it does.
JSON takes no comments, so the reasoning lives here — change the config, change
this file. Written during the pre-public hardening pass.

The threat model this serves is in [SECURITY.md](../SECURITY.md): the webview is
the boundary, and a note is untrusted content that can arrive by sync or import.

## Content-Security-Policy

`csp` was `null` — meaning Tauri shipped no policy at all, so any HTML a note
could get into the DOM could pull and run a remote script. The policy below is
derived from what the app actually does, not from a template; each allowance has
a call site.

```
default-src 'self'; script-src 'self' substrate-kind: http://substrate-kind.localhost;
style-src 'self' 'unsafe-inline';
font-src 'self' data:; img-src 'self' asset: http://asset.localhost data: blob:;
media-src 'self' asset: http://asset.localhost data: blob:;
connect-src 'self' substrate-kind: http://substrate-kind.localhost asset: http://asset.localhost ipc: http://ipc.localhost data: blob:;
worker-src 'self' blob:; object-src 'none'; base-uri 'self';
frame-src 'none'; frame-ancestors 'none'; form-action 'none'
```

- **`script-src 'self'`** — no `'unsafe-inline'`, no `'unsafe-eval'`, no remote
  origin. This is the directive that matters: it is what stops a crafted note
  from executing anything.
- **`substrate-kind:` / `http://substrate-kind.localhost` in `script-src` and
  `connect-src`** — the custom-kind scheme, and the only reason
  `script-src` is not bare `'self'`. Custom dashboard kinds are JS that lives in
  the vault (`.vault/kinds/<id>/`), so it cannot be bundled and cannot be
  `'self'`; a scheme handler is what lets it load *and* stay refusable. Two
  spellings because Tauri serves custom schemes as `substrate-kind://localhost/…`
  on macOS/Linux and `http://substrate-kind.localhost/…` on Windows/Android —
  the same handler, so both or neither. The first iOS build deliberately does
  not register the handler and `kinds_enable` refuses there; the shared CSP
  keeps the origin listed so enabling iOS later does not require widening the
  policy. What makes this narrow is the handler
  (`src-tauri/src/kinds.rs`), not the CSP: every request is refused with a bare
  404 unless the path resolves inside `<vault>/.vault/kinds/<id>/` after
  canonicalisation (traversal, absolute paths, separators and symlink escapes
  all die here), the id is enabled *for this exact vault path* in the
  out-of-vault `kinds.json`, and the bundle's current on-disk hash still equals
  the hash that was enabled. Edited files stop being served until the user
  looks again. Responses are `no-store` and `Access-Control-Allow-Origin` names
  the app origin alone. No `blob:`, no `data:`, no wildcard is added anywhere
  — those would let kind code fabricate its own script source and route around
  the whole check. `scripts/security-config.test.ts` pins both directives as
  exact lists for that reason.
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
  attribute was dead (0.16.0). Scoping the opt-out to `style-src`
  alone keeps Tauri's script hashing on `script-src`, which is the directive
  doing the security work. The real-app smoke run is the
  regression net — it runs the real bundle and fails if runtime
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
  where the SSRF guard can see it. Four do: link capture reads a page's title
  (`fetch_url_meta`); the finance surfaces read one USD→EUR rate from
  frankfurter (`fetch_usd_eur`, command `fx_usd_eur`); "Send as
  link" POSTs a sealed handoff payload to the user-configured relay
  (`share_upload`), and a calendar subscription reads a user-added
  remote ICS feed (`calendarfeed.rs`). Every user-controlled
  destination rides `guard_url`; redirect-following reads re-check every hop,
  while handoff uploads refuse redirects. A synced vault therefore cannot
  point the app at the local network. Only the handoff request carries a
  payload, and that payload is ciphertext — the note is AES-256-GCM-sealed in
  the webview first, and the key exists nowhere but the share link's
  `#fragment` (`src/lib/handoff.ts`, `scripts/handoff-relay/`).

  Three of those four have an off switch in `Settings.md`, all default on and
  grouped under "Outbound requests" in the ⌘, sheet:
  `net-link-titles`, `net-fx-rates`, `net-share-relay`. **Enforcement is at the
  app's request-initiating call sites**, not in `net.rs` — the engine makes a
  request only because something in the frontend asked it to, so a closed
  switch means the ask never happens. `netAllowed()` in `src/lib/settings.ts`
  is the one reader; only an explicit `false` closes a switch, so a typo'd
  value leaves the app behaving as documented rather than quietly losing a
  feature. The gates: link capture passes `enrich: false` to `url_capture`,
  which then skips `spawn_url_enrichment` (the note is still created, keeping
  the bare URL as its title — capture is local, only the title fetch is
  remote); `useFx` is to skip the rate fetch and serve the last cached rates
  with their date (`net-fx-rates` is enforced at the shared, deduplicated FX
  refresh seam); `SendLinkDialog` explains the
  switch instead of offering a send,
  and re-checks it in `send()` so a stale render can't upload anyway. Turning
  one off removes a capability, it does not add a security boundary: a user
  who wants the guarantee that nothing leaves has the CSP and the firewall,
  not a frontmatter key in a file that syncs.
- **`object-src 'none'` / `frame-src 'none'` / `frame-ancestors 'none'` /
  `form-action 'none'`** — the app has no `<iframe>`, `<object>`, or `<form>`
  submission anywhere. Denying them costs nothing and closes three classes of
  injection.

`devCsp` is the same policy plus what Vite's dev server needs and nothing else:
`'unsafe-inline' 'unsafe-eval'` in `script-src` for the dev transform, and
`ws://localhost:1420 http://localhost:1420` in `connect-src` for HMR. These
relaxations exist only in `tauri dev`; the shipped bundle uses `csp`. It is not
looser about *where* kind code may come from — a bundle that runs in dev and
404s in the shipped app is the worst possible failure mode here.

`npm test` only proves this file and the config agree. Whether a CSP actually
holds is a property of the packaged webview, and only the real-app smoke run
(`SMOKE_BUNDLE=1`) exercises it. A green gate run
is not evidence that a scheme or directive change works.

That port is hardcoded and coupled to `SUBSTRATE_DEV_PORT` in `vite.config.ts`
— JSON has no substitution, so the CSP cannot follow an override. Running the
dev server on another port only costs HMR:
the page loads, live reload goes quiet. Keep the two in step when 1420 changes.

## Asset protocol scope

The scope is broad on purpose, and that is a real tradeoff rather than an
oversight:

```
allow: $HOME/**, /Volumes/**, /tmp/**, /private/tmp/**
```

Two documented features defeat a tight allow list:

1. **The vault root is chosen at runtime.** `~/Vault` is only a default
   (`src-tauri/src/commands/app.rs:21`); `VAULT_DIR` overrides it
   (`lib.rs:380-384`). A static allow list cannot name a directory the user picks after
   the binary is built.
2. **Link-in-place embeds take absolute paths.** `![[/Volumes/audio/master.wav]]`
   and `![[~/Music/mixdown.flac]]` are documented, supported syntax
   (`docs/vault-format.md:182-195`) that resolves through `Engine::asset_info`
   (`src-tauri/src/vault/assets.rs:125`). Producers keep sample libraries on external
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

`~/Library/Mobile Documents` was allowed in earlier versions because it is where
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
