# Troubleshooting

Substrate is a macOS app over a folder of files, so most failures leave both
your vault and a useful local log intact.

## The app will not open after download

Use the current notarized DMG from the
[latest GitHub release](https://github.com/x9x9x9x9x9x91/substrate/releases/latest).
Open the DMG, drag `Substrate.app` into Applications, and launch that copy.
On first launch, macOS may show the normal downloaded-from-the-internet
confirmation; choose **Open**.

“Unidentified developer,” “damaged,” or “Apple cannot check it” is not expected
for an official release. Delete that app copy and DMG, download them again from
the link above, and retry. Do not disable Gatekeeper or strip the quarantine
attribute as a routine fix. Apple explains the available checks and overrides in
[Open apps safely on your Mac](https://support.apple.com/102445); only override a
warning when you have verified the download's source.

Older, unsigned builds could hang before the app started when macOS quarantined
them. Current releases are signed and notarized, and the repository ships a
verification script (`scripts/verify-quarantine.sh`) that can be run against a
built DMG to prove it survives the quarantine path a real download takes. If the
Dock icon appears but no window opens, force-quit the app, install a
fresh current release, and report it if the problem repeats.

## Find the diagnostic log

The desktop app writes to:

```text
~/Library/Logs/Substrate/substrate.log
```

In Finder, choose **Go → Go to Folder…** and paste that path. Reproduce the
problem, quit Substrate, then attach `substrate.log` to a
[bug report](https://github.com/x9x9x9x9x9x91/substrate/issues/new). Also attach
`substrate.log.1` if it exists; the log rotates there after about 1 MB. Each
launch writes the app version as its first line, so after a rotation the version
for an older session may sit in `substrate.log.1` rather than in `substrate.log`.

The log can contain local file paths and remote URLs. Read it and redact anything
personal before posting it publicly. For a security problem, follow the private
reporting route in [SECURITY.md](../../SECURITY.md) instead of opening a public
issue.

## An update does not appear

The first update check runs about 20 seconds after launch and failures stay quiet
when the Mac is offline or GitHub is unavailable. Leave the app open and try
again later, or install the latest DMG manually; replacing the app does not touch
the vault. See [upgrades, backup, and restore](upgrades-and-backups.md).

## A file I created is missing from the app

If you created `AGENTS.md`, `CLAUDE.md`, or `Settings.md` at the vault root in
another editor, Substrate hides it on purpose: those are the files the app itself
owns, and a fresh vault reads better without them. The file is still on disk, in
Finder, in backups, and in sync — only the app's note lists, search, and palette
filter it out.

Turn on **Settings (⌘,) → General → Show app files** to see them again. Only those exact
root filenames are hidden; a note of your own with a similar name, or one in a
subfolder, is never affected. See
[files, settings, and views](files-and-settings.md).

## A note opens as a grid, not as text

A note with the property `type: sheet` is a spreadsheet, so the app renders an
editable table over its CSV and formula blocks instead of the text editor.

To edit the raw text — to fix the CSV by hand, change the formulas, or write body
text around them — use the note icon in the sheet's toolbar, **View note source**;
**← grid** switches back. If the note was never meant to be a sheet, remove its
`type: sheet` property and it becomes an ordinary note.

## A setting I changed did not apply

App settings are properties in `Settings.md` at the vault root, and the
Settings sheet (⌘,) is a form over that same note — not a second copy. Either way
of editing is valid and the last write wins; a direct edit to the note is picked
up within about a second, with no restart.

Two things account for most surprises:

- **The sheet was already open when the note changed.** It reads the note when it
  opens. Close and reopen it to see values edited elsewhere.
- **A single database has its own override.** Column widths, sorting, visible
  columns, and table grid lines are stored per database and win over the global
  setting for that database. Toggle that database's own control back to the
  global value and it follows the setting again.

Deleting the setting's line in `Settings.md` is the sure way back to the
default (clearing a form field only does the same for text fields — and the
relay URL field turns the feature off instead). Full explanation in
[files, settings, and views](files-and-settings.md).
