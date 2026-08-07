# MCP door — scoped, permission-gated MCP access to the vault

The contract for the MCP door and its headless twin, the CLI door. Phase 1 is
built and user-reachable: the scope engine, the stdio server
(`src-tauri/src/mcpdoor/`, sidecar binary `substrate-mcp`) and the Settings
grant pane all ship. Grants are created, inspected and revoked in Settings;
hand-editing `mcp-scopes.json` is not part of the user workflow.

To wire a client up, jump straight to [Setup](#setup-phase-1); everything
before it is the security reasoning that decides what the door will and will
not do.

## Why this exists

For local agents, files are the API — that stance stays correct and
[vault-format.md](vault-format.md) stays the contract. The MCP door serves the one audience
files can't: AI tools with no filesystem access. Claude Desktop, ChatGPT
desktop, editors and future clients speak MCP and can spawn a local server;
claude.ai-class web tools need a remote transport. The door lets those tools
read and write the vault **under explicit, per-folder permission**, with every
write attributable after the fact.

Non-goal: replacing file access for local agents. If a tool can read files,
it should read files.

## Threat model

The MCP client is **untrusted**. Not because the vendor is hostile, but
because the model driving it is steerable: a prompt-injected cloud assistant
will happily ask for `~/Vault/Finance/` or walk a symlink out of the vault.
Design consequences:

1. **Default-off.** No grants → no server. There is no "enable MCP" master
   switch that opens the whole vault; capability exists only as the sum of
   explicit per-folder grants.
2. **Grants are per-machine, never vault content.** They live in the app
   config dir next to `config.json` (`appcfg.rs` rationale), NOT in the vault
   or `Settings.md`. A synced vault must never be able to grant itself access
   on another machine — same class of concern as `guard_url` on the share
   relay target.
3. **Containment is checked on the resolved path, not the requested one.**
   Symlinks, `..`, case tricks — the scope engine canonicalizes before it
   compares (see `mcpdoor::scope`). A grant on `Notes/` must not be walkable
   to `Finance/` via a planted symlink; a vault is untrusted content
   (SECURITY.md) and sync can plant files.
4. **Writes are attributable.** Every MCP-originated write commits through the
   existing vault history machinery with a distinct author identity
   (`Substrate MCP <mcp@local>` vs the app's `Substrate <substrate@local>`),
   carrying the client name in the message. This is the receipts story:
   "who set this value" must be answerable for MCP edits from day one, even
   before the receipts UI exists.
5. **No open port until the remote-transport phase**, and that phase gets its
   own security review. stdio has no network surface at all.

## Transport phases

- **Phase 1 — stdio (local clients), built.** A `substrate-mcp`
  sidecar process speaking MCP over stdio, spawned by the client (Claude
  Desktop, ChatGPT desktop, Cursor…). No port, no auth problem — the OS user
  boundary is the auth. `src-tauri/src/mcpdoor/server.rs`; entry point
  `src-tauri/src/bin/substrate-mcp.rs`. Resolves the vault exactly like the
  app (`VAULT_DIR` → stored choice → `~/Vault`; first-run refuses) and exits
  non-zero before serving when no grants exist. Grants are re-read on every
  tool call, so revoking works against an already-connected client.
  Every line that is not a JSON object — a batch array, a bare scalar — is
  answered with `-32600` on a null id rather than ignored, and a request
  carrying an id but no method gets `-32600` on that id: a client must never
  block waiting for a reply that will not come. Batch arrays are a documented
  refusal, not silence; MCP does not require batching and phase 1 does not
  implement it.
- **Phase 2 — Streamable HTTP (remote/web clients).** Only if demand shows
  up. Requires real auth (MCP OAuth resource-server flow or tunnel pairing),
  TLS, and its own review. Nothing in phase 1 may assume or pre-build this.

## Scope model (implemented in `src-tauri/src/mcpdoor/`)

A **grant** = one exact MCP client name + one vault-relative folder prefix +
an access level:

- `read` — list/read notes under the prefix.
- `write` — read plus create/edit under the prefix. Write never includes
  delete in v1; there is no `delete` level yet (trash semantics are a later
  call).

The **scope set** is the per-machine list of every client's grants. On each
tool call the sidecar first filters it to the exact `initialize.clientInfo.name`
for that process, then the effective decision for a path is the most
permissive covering prefix (grants only widen, there are no deny-overrides —
absence of a grant is the deny). The stdio name is self-reported, so the OS
user boundary remains the authentication boundary; the client dimension is
least privilege and visibility between configured local clients, not remote
authentication. A future remote transport must bind grants to its own stable,
authenticated subject.

Two ceilings sit above every grant, both case-insensitive and both regardless
of which client asks:

- **Hard-denied**: every leading-dot segment at ANY depth (`.vault/`, `.git/`,
  and future tool metadata) plus root `Settings.md`. Config and history
  surfaces are never exposed through the door at any level. The dot rule
  covers `.git/` deliberately — a writable `.git/config` is arbitrary code
  execution via fsmonitor or an alias. It runs at every depth, not just the
  root, because vault machinery is not all root-level: sealed notes
  place a `.substrate-seal` marker inside the folder it protects, holding the
  age recipient that new notes there are encrypted to. Readable, it maps which
  folders are secret; writable, a client could redirect the recipient at a key
  it controls. No legitimate note path has a dot-leading segment, so the
  shape-level rule needs no per-artifact allowlist to keep up.
- **Read-only ceiling**: root `AGENTS.md` and `CLAUDE.md`. A client may read
  the house rules — that is how it learns the vault's conventions — but no
  grant, a root write grant included, can rewrite them: authoring the
  instructions the *next* agent follows is an injection foothold that
  outlives the session and is invisible in the note the user is looking at.
  Deliberately not configurable in phase 1; a future per-grant relax would be
  a grant-pane decision, not a silent default.

A note with one of those names inside an ordinary folder remains ordinary
content. `note_create` decides the destination path it would write, not just
the folder, so a create cannot land on one of these surfaces either.

Both ceilings compare ASCII case-insensitively but do NOT Unicode-normalize:
on APFS a decomposed (NFD) spelling of a name is the same file as its
composed (NFC) spelling, so a hypothetical denied name containing non-ASCII
letters could be reached through the other spelling. Every name on the deny
lists today is pure ASCII, where the two forms are identical, and the
leading-dot rule is a single character that has no alternate spelling — so
there is no live hole. It becomes one the moment a non-ASCII name is added to
a deny list; that addition must bring NFC folding with it.

Grant file: `mcp-scopes.json` in the app config dir. Missing file = empty
scope set = door closed.

```json
{
  "grants": [
    { "client": "Claude Desktop", "prefix": "Projects", "access": "write" },
    { "client": "Cursor", "prefix": "Reference", "access": "read" }
  ]
}
```

Settings preserves unknown top-level and per-grant keys when it edits this
file, leaving room for later transport/subject metadata. A corrupt file keeps
the sidecar closed and is reported by Settings rather than overwritten.

## Setup (phase 1)

The macOS bundle carries `substrate-mcp` beside the main executable at
`Substrate.app/Contents/MacOS/substrate-mcp`; both nested executables are
signed as part of the app. Settings shows the exact installed path and the
Claude Desktop config location, with a copyable entry shaped like:

```json
{
  "mcpServers": {
    "substrate": {
      "command": "/Applications/Substrate.app/Contents/MacOS/substrate-mcp"
    }
  }
}
```

The entry carries a `command` and no `args`: the sidecar serves MCP over
stdio only when spawned with **no arguments**. Any argument at all — even a
well-meant `--stdio` or `serve` — puts it in headless CLI mode, where it
reports a usage error and exits instead of serving.

The user grants at least one folder before launching the client. No grants
means the sidecar exits before serving. Merge the shown `mcpServers` member
into an existing config rather than replacing unrelated servers, then fully
quit and reopen Claude Desktop.

## Tool surface (phase 1)

Deliberately small and vault-shaped, not filesystem-shaped:

- `vault_list(folder)` — notes + subfolders under a granted prefix. Folders
  on the way DOWN to a grant are revealed as bare names (so a client granted
  `Notes/Sub` can navigate from the root), their contents are not.
- `note_read(path)` — frontmatter + body, decided on the resolved path.
- `note_write(path, body)` / `note_create(folder, title, type)` — write-level
  grants only; receipt-stamped commit per write.
- `vault_search(query)` — the granted-path allow-list is pushed into the
  engine's scoped search, so ungranted folders never leak titles/snippets —
  not even as trimmed rank-N rows of a capped page.

No raw-byte/file tools, no asset access, no shell, no config.

### Receipts mechanics

Every MCP write commits through the vault history repo via
`History::commit_paths_as`: staging is scoped to the written path, the
**author** is `Substrate MCP <mcp@local>` with the tool + path + client name
in the message, and the **committer** stays `Substrate <substrate@local>` so
the all-Substrate adoption heuristics keep recognizing the repo. Git is run
with literal pathspecs, so legal filenames containing `*`, `?`, or pathspec
magic cannot sweep unrelated dirty notes into the attributed commit. If the
target note carries uncommitted user edits, they are fenced first in a
normal-identity `snapshot before MCP edit` commit — and a fence failure
refuses the MCP write, because attribution integrity outranks the edit. On a
foreign (user-owned) repo the write happens but is not snapshotted, and the
receipt says so.

Every write result carries a `receipt` field, and that field — not the exit
code or the absence of an error — is where attribution outcomes are reported:
the commit that was made, or the reason there is none. It is the channel to
read when a caller cares who the history says wrote the note.

The decision check and filesystem write are adjacent but not one atomic OS
operation in phase 1; failures stay closed, and a future remote/long-lived
transport must use fd-relative opens before claiming a race-free boundary.
The app's separate auto-snapshot process can win the short write→receipt
race; when no attributable change remains, the receipt says that another
snapshot may have captured it instead of claiming a clean MCP receipt. A
process crash inside that same gap likewise leaves the content recoverable in
history but without MCP authorship; this is an explicit phase-1 limitation.

## Headless callers — the CLI door

Scripts, cron jobs and shell pipelines need the same scoped access AI clients
get. They get it from the same binary: `substrate-mcp` with **no arguments**
serves MCP over stdio, and `substrate-mcp` **with** arguments performs one
scoped operation and exits.

```
substrate-mcp read Notes/today.md --client my-script
substrate-mcp write Notes/today.md --body "text" --client my-script
echo "text" | substrate-mcp write Notes/today.md --client my-script
substrate-mcp create Notes --title "New note" --type note --client my-script
substrate-mcp list Notes  --client my-script
substrate-mcp search query --client my-script
```

`substrate-mcp --help` prints the full surface. `write` with neither `--body`
nor `--body-file` reads the body from stdin and waits for end-of-input — pipe
it, or pass `--body`. Output is JSON on stdout; refusals print a one-line
reason on stderr. Exit codes are the contract: `0` done, `1` usage error,
`2` the door is closed (no grants) or failed to open, `3` no vault on this
machine, `4` **refused** — a script can tell "I asked wrong" from "I am not
allowed" from "the door is shut" without parsing prose.

What the codes settle is whether the call was allowed and whether it ran —
not how well it went afterwards. A write that lands but cannot be attributed
(nothing left to commit, or the receipt commit itself failed) is still a
landed write and still exits `0`; the `receipt` field in the JSON result
carries that outcome, so a script that cares about authorship reads that
field rather than the exit code. Exit `4` likewise covers everything the door
declined — not shared, note missing, arguments the tool rejected — so a
caller that must act on "revoked" specifically reads the stderr reason.

This is not a second door, and the shape is the reason. The headless path
parses argv into a single `initialize` + `tools/call` exchange and drives it
through the same server loop over in-memory buffers
(`src-tauri/src/mcpdoor/cli.rs`). It is a *caller* of the contract above:
same `mcp-scopes.json`, same per-call grant reload, same ceilings, same
resolved-path containment, same receipts. There is no CLI-side permission
decision that could drift from the server's, because there is no CLI-side
permission decision.

Grants are per client **name**, so `--client` is required (or
`SUBSTRATE_MCP_CLIENT`) and must match a granted name exactly. A script
therefore holds its own grants, appears as its own row in the grant pane, and
cannot borrow a chat client's access by accident. Writes commit with the
door's identity and the script's name in the message, exactly as in
[Receipts mechanics](#receipts-mechanics) — the git log distinguishes
which caller made which edit.

## Product decisions

Four calls that shape the surface, recorded so a later change is a decision
rather than a drift:

- **Grant UX**: Settings pane only — a folder picker in Settings, no
  per-folder context menu. Granting is a deliberate act in one place, not
  something you can do by reflex while browsing.
- **Naming**: MCP stays the user-facing name. No friendlier label papering
  over the protocol term — if a pane hands a cloud client access to your
  notes, it should say exactly what it is.
- **Visibility + revoke**: Settings shows which client holds which folder
  grants, with per-grant revoke plus one-click revoke-all. The grant file
  carries an exact client-name dimension so the pane can show that truthfully.
- **Phase 2 (remote)**: planned for, not pre-built. Phase-1 decisions must
  leave the door open for a remote transport; nothing may preclude it.


