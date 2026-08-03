# Upgrades, backup, and restore

The app bundle and the vault are separate. Replacing or removing
`Substrate.app` does not replace or remove your notes.

## Upgrade Substrate

Substrate checks GitHub Releases shortly after launch and every 12 hours while
it stays open. When a release is available, choose **Install** in the toast. The
signed update downloads and installs in the background; choose **Restart now**
when it is ready.

To upgrade manually, quit Substrate, download the latest notarized DMG from the
[releases page](https://github.com/x9x9x9x9x9x91/substrate/releases/latest),
and drag its `Substrate.app` over the existing copy in Applications. Choose
**Replace**, then launch it normally. Your selected vault and its contents stay
where they are.

## Back up a vault

Quit Substrate, then copy the entire vault folder to another disk or a versioned
backup service such as Time Machine. Do not select only the visible `.md` files:
the folder also contains hidden data including embedded files in `.assets`,
recoverable deletions in `.trash`, database and view configuration in `.vault`,
and local version history in `.git`.

Vault Git sync is useful for moving tracked notes and configuration between
devices, but it omits assets and Trash and propagates deletions. It is not a
replacement for a separate whole-folder backup.

## Restore a vault

1. Copy the backed-up vault folder to the location where you want to keep it.
   Keep the backup itself until you have checked the restore.
2. Open Substrate and press **⌘,**. In the Vault row, choose **switch…**, then
   **Open an existing folder** and select the restored folder. On first launch,
   use **Open an existing folder** on the welcome screen instead.
3. Restart when prompted, then check a few notes and embedded files.

Nothing is moved when you switch vaults. If Substrate was launched with the
`VAULT_DIR` environment variable, that path takes precedence over the choice in
Settings until the variable is unset.
