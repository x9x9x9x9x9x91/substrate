# Sync and security

Substrate has no account, hosted vault service, or telemetry. Your vault is a
folder on your Mac, and ordinary editing does not upload it anywhere. The files
are plain text and are not encrypted by Substrate; use FileVault if the disk
needs encryption at rest. The fuller threat model is in
[SECURITY.md](../../SECURITY.md).

## What connects to the network

- **Update checks:** about 20 seconds after launch, then every 12 hours while the
  app remains open, Substrate requests the signed update manifest from GitHub
  Releases. GitHub sees an ordinary request from your connection; no vault
  content is included. Download and installation happen only after you choose
  **Install** in the update toast.
- **Vault sync:** nothing is sent until you configure an HTTPS Git remote.
  From then on sync is automatic (default on; one switch in the Sync pane):
  Substrate pushes shortly after your edits settle and pulls when the app
  opens, when the window regains focus, and every few minutes while it runs.
  The pane's **Push** and **Pull** buttons always work manually — one sync runs
  at a time, so a click while an automatic push or pull is still going waits for
  it to finish, which on a slow connection can be a few seconds. A conflict is
  never resolved for you — it parks in the Sync pane, automatic sync pauses,
  and the lane stays quiet about everything else: an unreachable remote is
  retried silently, and only a failure that persists for hours shows in the
  pane. Push sends the vault content tracked by its local
  history: notes, `Settings.md`, and most `.vault` configuration. Embedded
  `.assets`, recoverable `.trash`, and device-only notification state are not
  part of this Git sync. The remote URL is stored in the vault's local Git
  configuration; its access token is stored in the macOS Keychain under
  `com.substrate.vault-sync`, not in the vault.
  The remote can be a plain Git server over HTTPS, or an end-to-end encrypted
  blob store (a `blob+https://` URL in the Sync pane): with a blob remote your
  notes leave the device only as ciphertext — the server never holds note
  content, names, history, or your passphrase. The first device sets the
  passphrase, every other device repeats it, and losing the passphrase loses
  the vault; the derived encryption key is stored in the Keychain beside the
  token. The encryption is only as strong as that passphrase — whoever runs
  the server can try guesses against the stored wrapped key at their leisure,
  so a short or reused passphrase undoes the protection. Pick a long, unique
  one and keep it in a password manager. The matching server is open source (`hosted-sync-server/` in the
  repository), so the encrypted path is as self-hostable as the plain one.
- **Capturing a URL:** pasting a URL as a new reference creates the note locally,
  then requests that page to read its title and description. The request goes
  only to the pasted public URL (and checked public redirects); credentials in a
  `user:password@host` URL are removed first.
- **Send as link:** when you configure a share relay and explicitly use **Send
  as link**, the rendered note is encrypted on the Mac and only the ciphertext
  is uploaded. The decryption key stays in the link fragment and is not sent to
  the relay. Unlike the Git token, a share relay token is stored as plain text in
  `Settings.md` inside the vault, so it travels with every Push and sync of that
  vault — use a token you are willing to have in vault content. The two tokens sit
  in different places because they are scoped differently: the Git token is how
  *this Mac* reaches your remote, so it stays on the machine, while the relay is
  configured in `Settings.md` and therefore reaches every device that syncs the
  vault. Most relays need no token at all; leave the field empty unless yours
  gates uploads.
- **Currency conversion:** opening a sheet or a dashboard requests the one public
  USD→EUR reference rate from `api.frankfurter.dev`. No note content is included.
- **A subscribed calendar:** a calendar you add by URL is re-read from that
  address on a schedule, so the events stay current. The request goes only to
  the address you entered (and checked public redirects); no note content is
  included.
- **The speech model, once:** pressing the download button in Settings fetches
  the offline speech model Substrate transcribes with — about 574 MB, from a
  fixed address baked into the app, checked against a fixed checksum before it
  is installed. Asking for a transcript before that just tells you the model
  is missing; nothing downloads on its own. Nothing is uploaded, and there is
  no other moment at which voice capture touches the network: recording and
  transcription both run on your Mac. If you never press it, the download
  never happens.

Opening an ordinary note or database makes none of those requests. Links you
choose to open behave like links in any other desktop app and open in the
default browser.

## Sync is not a full backup

Git sync propagates edits and deletions and deliberately omits assets and Trash.
Keep a separate copy of the whole vault if you want a recoverable backup. See
[upgrades, backup, and restore](upgrades-and-backups.md).
