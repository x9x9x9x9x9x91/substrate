# Export and uninstall

## Export your data

The whole vault is already the bulk export: a normal folder of Markdown files
plus its supporting hidden folders. Quit Substrate and copy that folder wherever
you want it. No Substrate account or server is needed to read the files.

For smaller exports:

- A note's **⋯** menu offers **Export Markdown…**, which creates a portable
  folder containing the note and the embedded assets it uses, and **Export
  PDF…**, which opens the macOS print flow.
- A database's **⋯** menu offers **Export CSV…** for the columns, filters, sort,
  and row order currently shown.

## Uninstall the app

Quit Substrate and move `/Applications/Substrate.app` to the Trash. Your vault
is deliberately left alone. Keep it, move it, or delete it separately only when
you are certain the files and backups are no longer wanted.

For a completely clean uninstall of app-owned state, first ask the installed app
for its bundle identifier:

```sh
defaults read /Applications/Substrate.app/Contents/Info CFBundleIdentifier
```

Use the value printed there in place of `<bundle-id>`, then remove these paths
in Finder with **Go → Go to Folder…**:

```text
~/Library/Application Support/<bundle-id>/
~/Library/Logs/Substrate/
~/Library/Caches/<bundle-id>/
~/Library/WebKit/<bundle-id>/
~/Library/Preferences/<bundle-id>.plist
```

The Application Support folder contains the remembered vault location. Removing
it does not remove the vault itself. The exact `config.json` path is also shown
at the bottom of the **Settings → Vault → switch…** sheet. If you configured
vault sync, open Keychain Access and delete password items whose service is
`com.substrate.vault-sync` to remove the saved access tokens as well.

The optional demo vault lives at `~/Documents/Substrate Demo`. Treat it like any
other vault: inspect it before deciding whether to delete it.
