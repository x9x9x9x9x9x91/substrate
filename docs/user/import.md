# Bring your data in

Substrate reads plain markdown, so "import" is smaller than it sounds: most
data arrives either by opening a folder you already have or by writing files
into the vault. This page covers the supported paths, from zero-setup to
script-based.

## Already have a folder of Markdown files?

Point Substrate at it. On first run (or whenever no vault is configured) the
app shows a picker — choose your existing folder and it opens in place. Your
notes are read where they are, never moved, renamed, or rewritten. Substrate
adds its hidden support folders (`.vault/`, version history) next to them,
plus two visible helper files when you don't already have them: `Settings.md`
(app settings) and `AGENTS.md` (a format guide for any AI tool you point at
the folder). Notes whose frontmatter carries a `type:` line already form
databases; plain notes are just notes. `[[Wikilinks]]` resolve the way you'd
expect.

The folder needs at least two `.md` files to be offered as a vault — a guard
against accidentally opening `~/Documents` — and adopting an existing folder
never seeds sample content into it.

## Import CSV as a database

In the app: **⌘K → "Import CSV as database…"**, pick a `.csv` file, choose
which columns to keep — the first kept column becomes each note's title, the
rest become properties. Each row becomes one note, and the rows form a
database like any other, so a spreadsheet exported from another tool becomes
tables, boards, and charts without a script.

## From Notion

`scripts/import-notion.ts` pulls one Notion database through Notion's public
API and writes one note per row: properties become frontmatter (names
lowercased), page bodies become note bodies. It runs from a checkout of this
repository, not from the app:

```sh
NOTION_TOKEN=secret_… VAULT_DIR=~/Vault \
  npm run import:notion -- --database "Reading List" --folder "Import/Reading" --type reading
```

Worth knowing:

- You need a [Notion internal integration](https://www.notion.so/my-integrations)
  token, with the database shared to that integration. The token is used for
  the run and never stored.
- `--dry-run` prints what would be written without touching the vault.
- Re-running is safe: rows already imported (matched by their `notion_id`
  prop) are skipped, and existing files are never overwritten.
- One database per run; run it once per database you want.

The full option list (property renaming, fixtures) is in the header of
[`scripts/import-notion.ts`](../../scripts/import-notion.ts).

## From an Ableton project pool

`scripts/import-ableton.ts` turns a folder of Ableton projects into a
folder-backed database — one row per project, with the source tree strictly
read-only (it never parses or touches your `.als` files):

```sh
VAULT_DIR=~/Vault node scripts/import-ableton.ts ~/Music/Projects --type ableton-project
```

Re-running is the rescan: machine-owned props refresh, your own props and
note bodies are never touched, and a vanished project keeps its row flagged
`missing` instead of being deleted. Details in the script's header.

## Everything else

Any tool that can write a markdown file can import into Substrate — the vault
folder is the integration surface, and the running app picks changes up within
about a second. The rules for doing that safely (atomic writes, frontmatter
shape, the one helper script worth copying) are in
[Integrating external tools](../integrations.md).
