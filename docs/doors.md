# Doors — every way in and out

Substrate's integration surface is deliberately small: the vault is a folder of
plain markdown, and the files are the only source of truth. This page is the
index of every supported way to get things **into** and **out of** a vault, each
linking the document that owns its contract. If a door isn't listed here, it
doesn't exist — and that's a doc bug worth filing.

## Ways in

| Door | What it is | Contract / recipe |
| --- | --- | --- |
| The app | ⌘N to Inbox, ⌥Space global capture from any app, ⌘K palette; paste a URL to capture it as a reference note (title fetched from the page) | [README §Keys](../README.md#keys) · [what the URL fetch sends](user/sync-and-security.md#what-connects-to-the-network) |
| Any tool that writes files | Write markdown into the vault folder; the watcher picks it up in ~300ms, running app or not needed. **This is the primary API.** | [Integrating external tools](integrations.md) · [vault-format §13, writer rules](vault-format.md#13-rules-for-well-behaved-external-writers) |
| `scripts/append-row.ts` | The blessed one-note-per-run creator: title sanitizing, YAML quoting, atomic create, refuses overwrites. Frozen surface. | [integrations.md §Snippet: the helper](integrations.md#snippet-the-helper) |
| Importers | `npm run import:notion` (one Notion database → one note per row, via the public API) and `npm run import:ableton` (a folder of Ableton projects → a folder-backed database, source strictly read-only). Both re-run safely. | Usage headers in [`scripts/import-notion.ts`](../scripts/import-notion.ts) and [`scripts/import-ableton.ts`](../scripts/import-ableton.ts) · [integrations.md §Existing integrations](integrations.md#existing-integrations-to-read) |
| Calendar subscriptions | Read-only external iCalendar feeds rendered into the calendar; never written back. | [vault-format §5c, `calendars.json`](vault-format.md#5c-vaultcalendarsjson--read-only-external-calendars) |
| Cookbook recipes | Ready-made dashboards as plain files — copy a folder into the vault and it renders; `index.json` makes the install a one-line agent prompt. | [cookbook/README.md](../cookbook/README.md) |
| The IPC surface | When the app is running and you want the engine's guarantees (link rewriting on rename, compare-and-swap writes), the app's own operations are the better door. | [vault-format §14](vault-format.md#14-the-ipc-surface-preferred-operations) |
| Agent seed | Every vault carries a seeded `AGENTS.md` orienting any AI agent pointed at the folder — the format rules travel with the data. | [vault-format §12](vault-format.md#12-app-level-conventions) |
| Terminal HUD | ⌘⇧T embeds your own agent CLI (whatever command you configure in ⌘, Settings) in a persistent in-app terminal, cwd'd at the vault. | In-app: ⌘/ shortcut sheet, ⌘, Settings |

## Ways out

| Door | What it is | Contract / recipe |
| --- | --- | --- |
| The files themselves | The vault is plain markdown on disk. Open it in any editor, grep it, back it up, delete Substrate — nothing is trapped. No export step exists because none is needed. | [README §Model](../README.md#model) |
| Export | Per-note Markdown (with assets) and PDF, per-database CSV of the current view, and link folders that mirror a saved view into Finder — plus the uninstall story. | [Export and uninstall](user/export-and-uninstall.md) |
| Vault sync | Push/pull the vault's built-in Git history to an HTTPS remote you configure. Nothing is sent until you set a remote and choose Push. | [Sync and security](user/sync-and-security.md) |
| Send as link | One note, encrypted on your Mac, shared through a relay; the key stays in the link fragment. | [Sync and security §What connects to the network](user/sync-and-security.md#what-connects-to-the-network) |

## Planned

Decided and tracked, not yet built — each flips into the tables above when it
ships:

- **`substrate://` deeplinks** — `substrate://note/<path>` and
  `substrate://capture`, so other tools can point at Substrate.
- **CLI door** — headless scoped access to vault operations,
  sharing the MCP door's permission engine: one contract, not two.
- **MCP door** — a permission-gated MCP server over the vault, for
  AI tools that can't read files.

What is deliberately **not** planned — webhooks, an HTTP endpoint, a plugin
lifecycle — and why, lives in
[integrations.md §What this is not](integrations.md#what-this-is-not).
