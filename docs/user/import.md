# Bring your data in

Substrate reads plain markdown, so "import" is smaller than it sounds: most
data arrives either by opening a folder you already have or by writing files
into the vault. This page covers the supported paths, from zero-setup to
script-based.

## Already have a folder of Markdown files?

Point Substrate at it. On first run (or whenever no vault is configured) the
app shows a picker — under **Open an existing folder**, browse to your folder
and confirm. The choice is stored per machine and takes effect after a
restart; the app tells you so and offers the restart button.

Your notes are read where they are: **nothing is moved, renamed, or
rewritten**. Folder structure is kept as-is — nested folders stay nested, and
notes are never reorganized into the app's own layout.

### What Substrate adds to your folder

Adoption is not inert. It adds its own files alongside your notes — it never
moves, renames or rewrites the notes themselves:

| Path | What it is |
| --- | --- |
| `.vault/` | Substrate's own state for this folder: database schemas, saved views, templates, folder and tag-folder definitions, mounted external folders, calendar subscriptions. **Not** a cache — deleting it destroys that work, and it cannot be rebuilt from your notes. |
| `.git/` | A git repository, created here if the folder isn't one already, holding your version history. See below. |
| `Inbox/` | Empty folder where new scratch notes land. |
| `Settings.md` | App settings as an ordinary note you can edit. |
| `AGENTS.md` | A format guide for any AI tool you point at the folder. |
| `CLAUDE.md` | A one-line pointer at `AGENTS.md`, for agents that only auto-load that filename. |
| `.claude/skills/setup/SKILL.md` | A `/setup` skill for the built-in terminal's agent. |

The search index is not on disk at all — it is built in memory at startup
from the notes themselves, so nothing here is a search cache.

`Settings.md`, `AGENTS.md`, `CLAUDE.md` and the `/setup` skill are written
only when a file of that name isn't already there — your own `AGENTS.md` or
`Settings.md` is never overwritten. (A file that still byte-matches a version
Substrate itself shipped is refreshed to the current text; anything you've
edited is yours and is left alone.) No sample or starter notes are ever
seeded into a folder you adopt — that only happens for a brand-new, empty
vault.

#### Version history and `git`

Version history is git, in the adopted folder itself. Which way that goes
depends on what you point at:

- **Folder that isn't a git repository** — Substrate runs `git init` in it
  and marks the repository as its own. History is on: you get a snapshot per
  change, and the timeline in the app.
- **Folder that is already your git repository** — Substrate leaves it
  completely alone and **history stays off**. It will not commit into a
  repository you own, so an adopted checkout keeps whatever branch, remote
  and working tree it had.

So adopting an ordinary Obsidian vault does create a `.git/` directory inside
it. If you'd rather not have one, keep the folder under your own git
repository before adopting it.

### What carries over from Obsidian (and what doesn't)

Substrate reads plain Markdown, so an Obsidian vault mostly just works — but
it is a different app, not a compatibility layer.

Carries over:

- **`[[Wikilinks]]`** — resolved by note title or filename, case-insensitively,
  wherever the note lives in the tree. Backlinks work off the same index.
- **Link aliases and heading anchors.** `[[Note|shown text]]` shows the alias
  in place of the target, and `[[Note#Heading]]` opens the note scrolled to
  that heading — `[[Note#^block-id]]` to a block ref. An anchor no heading
  answers to leaves the note at the top rather than jumping somewhere
  arbitrary. Backlinks index on the target alone, so an aliased or anchored
  link counts exactly like a plain `[[Note]]`. The `[[` autocomplete offers
  headings and block refs after a `#`, and label suggestions after a `|`.
- **Embeds** — `![[image.png]]` shows the asset instead of the link text, and
  is not counted as a link.
- **YAML frontmatter** — every key is kept. A `type:` line is the one with
  special meaning: notes sharing a type form a database (table, board, chart)
  automatically. Other props become that database's columns.
- **Tags** — inline `#hashtags` and a `tags:` prop are merged into one tag set.
- **Nested folders**, and any file extension other than `.md` (attachments
  stay where they are and are served as assets).
- **Callouts** in the `> [!note]`, `> [!warn]` and `> [!idea]` shapes.
  Other callout types render as ordinary blockquotes.

Does not carry over:

- **Obsidian's own config.** `.obsidian/` is skipped entirely: not indexed,
  not shown, not modified — and so is every other dot-folder that isn't
  Substrate's (it writes only the `.vault/`, `.git/` and `.claude/` entries
  listed above). Your Obsidian setup survives untouched, so you can keep
  using both apps on the same folder.
- **Community plugins.** Nothing in `.obsidian/plugins/` runs.
- **Dataview queries.** A ```` ```dataview ```` block is displayed as a code
  block, not executed. Substrate's equivalent is a database view or a
  dashboard, built against the same `type:` frontmatter the notes already
  have.
- **Canvas files.** `.canvas` files are left alone but not rendered.

### The two-file guard

A folder is offered with **Open vault** when it has a `.vault/` marker or at
least two Markdown files at its top level. That guard is what stops a stray
pick of `~/Documents`, or a code checkout with one `README.md`, from becoming
a vault by accident.

A vault whose notes all live in subfolders can therefore fall short of it —
you'll get **Initialize anyway** with a warning that the folder holds other
files. Confirming is safe: it means the same adoption as above, the warning
is about Substrate listing those files as notes, and nothing is moved,
rewritten, or seeded.

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
