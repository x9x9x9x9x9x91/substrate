Substrate settings — edit and save; changes apply within a second (⌘, opens the settings form).

- `capture-hotkey` — global quick-capture shortcut, works from any app (e.g. `alt+space`, `cmd+shift+j`)
- `close-to-tray` — when `true`, closing the window keeps Substrate in the menu bar; quit from the tray menu
- `terminal-command` — command the ⌘⇧T terminal runs on start (e.g. `claude`, `codex`); empty = plain shell
- `terminal-cwd` — folder the terminal starts in (`~` expands); empty = the vault folder
- `terminal-font` — font family for the terminal, e.g. a nerd font so prompt glyphs render (`JetBrainsMono Nerd Font`); empty = the app's mono
- `terminal-dock` — which edge the ⌘⇧T terminal slides in from: `bottom` or `right`; drag its inner edge to resize either way
- `terminal-height` — how much of the window the terminal covers when docked to the bottom (`0.2`–`0.9`, default `0.45`)
- `terminal-width` — how much of the window the terminal covers when docked to the right (`0.2`–`0.7`, default `0.38`)
- `terminal-actions` — command-palette quick actions, one `Label: command` per list entry; each types its command into the terminal
- `drop-hint` — when `false`, hides the drag-over hint about copy vs ⇧-link (default `true`)
- `mod-hud` — when `false`, holding ⌘ no longer folds out the shortcut HUD (default `true`)
- `db-grid` — when `false`, turns off the vertical grid lines in database tables everywhere; a database's ⋯ menu can still override per database (default `true`)
- `show-agent-files` — when `true`, lists the seeded `Settings.md`, `AGENTS.md`, and `CLAUDE.md` app files; by default they stay concealed (still normal files on disk)
- `share-relay-url` — where “Send as link” parks the encrypted copy; defaults to Substrate's hosted ciphertext-only relay, or replace it with your self-hosted relay
- `share-relay-token` — optional bearer token for a self-hosted relay that gates uploads; the hosted default does not use one
