# Security

Substrate is a local-first notes app: your vault is a folder of markdown files
on your own disk, and the app is the thing that reads and renders them. That
shapes what the app can protect and what it can't — the section below is honest
about both.

## Reporting a vulnerability

Please report privately rather than opening a public issue.

**Use GitHub's private vulnerability reporting**: go to the repository's
**Security** tab and press **Report a vulnerability**. That opens a private
advisory visible only to you and the maintainers — it is the canonical channel,
and the only one guaranteed to be read. Do not open a public issue, and do not
post details in a pull request or discussion before a fix ships.

If that button is not available to you, open a minimal public issue saying only
**"security — requesting a private contact"**, with no details of any kind, and
wait to be contacted privately.

What helps: the version, what you did, what happened, and whether it needs a
crafted vault or note to reproduce (attach it if so). Expect an acknowledgement
within a week. There is no bounty; the project is one person's tool that other
people are welcome to use.

## Supported versions

The latest released version is the only supported one. Substrate is
pre-1.0 and ships from `main` — fixes land in the next release rather than in
patches to older tags. If a fix is urgent enough to matter, it is worth
upgrading for.

## Threat model

**What Substrate is.** A desktop app (Tauri: a Rust backend and a system webview
frontend) over a folder of plain files. There is no Substrate account, hosted
vault server, or telemetry. Local-first is not the same as offline-only: the
small set of automatic and user-triggered network requests is documented in
[sync and security for users](docs/user/sync-and-security.md).

**Who the app trusts.** You, your machine, and the OS user account you run under.
Anything running as your user can already read your vault directly — the app
cannot and does not try to defend against that.

**Who it does not trust.** The *contents of a note*. A vault is a folder that
travels: it syncs between your devices, and notes arrive by import, download, or
someone else's pull request into a shared vault. So note content is treated as
untrusted input even though the vault as a whole is yours.

That distinction drives the defenses that exist:

- **A note cannot execute code.** The webview runs under a
  Content-Security-Policy with `script-src 'self'` — no inline script, no `eval`,
  no remote script origin. Rationale and the full policy:
  [docs/security-config.md](docs/security-config.md).
- **A note cannot make the app reach into your network.** Every place the app
  fetches a URL — link previews, the USD→EUR reference rate, **Send as link**
  uploads, and external calendar subscriptions — resolves the host first and
  refuses loopback, private,
  carrier-grade-NAT, link-local, and unique-local addresses, on the initial
  request *and* on every redirect hop, and refuses any scheme other than
  `http`/`https` (`src-tauri/src/net.rs`). That matters most for URLs from
  vault content, including the share relay URL in `Settings.md`. Calendar
  subscriptions are the one fetch that also repeats on its own: once you add a
  feed, the app refetches it in the background every 30 minutes while it is
  running, unattended.
- **A synced note cannot silently run a command.** Settings.md can name a
  `terminal-command` for the terminal HUD. It runs only after you approve that
  exact command on that machine; the approval is a hash in local app state and is
  never written into the vault, so approving on one device does not approve on
  another. Change a character and you are asked again.
- **A note cannot read your credential files through an asset URL.** Asset-protocol
  access denies `~/.ssh`, `~/.gnupg`, `~/.aws`, cloud and container configs, shell
  history, `.env` files, `.git` internals, and the private parts of `~/Library`.
- **Sync tokens live in the system keychain**, not in the vault and not in a
  config file.

## Known limitations

Stated plainly, because a threat model that only lists wins is marketing:

- **Asset scope is broad.** Because the vault root is chosen at runtime and
  embeds may point at absolute paths (external drives full of samples are a real
  use case), the asset protocol can read most ordinary files under your home
  directory. With the CSP in place there is no channel to send those bytes
  anywhere, so the practical risk is that a hostile note could *display* a file
  you already have. Tightening this needs a real path-authorization feature.
- **Your vault is not encrypted at rest.** It is plain markdown by design. Full-
  disk encryption (FileVault) is the right layer for that.
- **DNS rebinding is out of reach.** The link-preview guard checks the addresses
  a host resolves to at request time; a host that answers differently a moment
  later can still be reached. Mitigating it properly requires pinning the
  resolved address into the connection, which the HTTP client does not expose.
- **Anything running as your user wins.** Another process on your machine can
  read the vault, the local approval store, and the keychain entry (subject to
  the OS prompt). This app is not a sandbox.
- **No third-party audit.** Nobody outside the project has reviewed this.
