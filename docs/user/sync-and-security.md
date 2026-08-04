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
- **Vault sync:** nothing is sent until you configure an HTTPS Git remote and
  choose **Push** or **Pull**. Push sends the vault content tracked by its local
  history: notes, `Settings.md`, and most `.vault` configuration. Embedded
  `.assets`, recoverable `.trash`, and device-only notification state are not
  part of this Git sync. The remote URL is stored in the vault's local Git
  configuration; its access token is stored in the macOS Keychain under
  `com.substrate.vault-sync`, not in the vault.
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

Opening an ordinary note or database makes none of those requests. Links you
choose to open behave like links in any other desktop app and open in the
default browser.

## Sync is not a full backup

Git sync propagates edits and deletions and deliberately omits assets and Trash.
Keep a separate copy of the whole vault if you want a recoverable backup. See
[upgrades, backup, and restore](upgrades-and-backups.md).
