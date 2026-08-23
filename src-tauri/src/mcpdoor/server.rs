//! MCP door phase-1 stdio server.
//!
//! `substrate-mcp` (src/bin/) is the entry point: an MCP client (Claude
//! Desktop, ChatGPT desktop, an editor) spawns the binary and speaks MCP —
//! newline-delimited JSON-RPC 2.0 — over stdin/stdout. No port, no HTTP;
//! a remote transport is phase 2 and gets its own security review
//! under a separately reviewed design.
//!
//! The tool surface is vault-shaped and small: `vault_list`, `note_read`,
//! `note_write`, `note_create`, `vault_search`. Every decision runs through
//! the scope engine (`super::scope`); writes check [`ScopeSet::decide_resolved`]
//! — never the string-level half alone — so a planted symlink cannot carry a
//! grant somewhere it doesn't reach.
//!
//! Grants are reloaded from `mcp-scopes.json` on EVERY tool call: deleting a
//! grant revokes access for a client that is already connected, without a
//! restart. An empty scope set at startup means the door does not open at
//! all (`run` exits before serving), matching default-off in the design.
//!
//! Receipts: each write commits through the vault's history
//! repo as `Substrate MCP <mcp@local>` — a distinct author from the app's
//! `Substrate <substrate@local>` — with the tool, path, and client name in
//! the message. Before an MCP edit touches a note that has uncommitted user
//! changes, those are fenced off in a separate normal-identity snapshot, so
//! an MCP commit never swallows the user's own edits under MCP authorship.

use std::io::{BufRead, ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::lastseen;
use super::scope::{validate_client, Access, Decision, ScopeSet};
use crate::history::History;
use crate::vault::{first_note_rel, sanitize_folder_rel, Engine};

/// MCP protocol revision this server implements.
pub(super) const PROTOCOL_VERSION: &str = "2025-06-18";

/// The distinct author identity of MCP-originated commits — receipts must be
/// able to answer "who set this value" with "an MCP client", not "the app".
const MCP_AUTHOR_NAME: &str = "Substrate MCP";
const MCP_AUTHOR_EMAIL: &str = "mcp@local";

/// The label of the fence snapshot that protects a user's uncommitted edits
/// from riding into an MCP-authored commit. Shows up in the History panel.
const FENCE_LABEL: &str = "snapshot before MCP edit";

pub struct Door {
    engine: Engine,
    history: Option<History>,
    /// Where `mcp-scopes.json` lives; re-read per call.
    cfg_dir: PathBuf,
    /// From `initialize`'s `clientInfo.name` — lands in commit messages.
    client: String,
}

impl Door {
    /// Open the door: refuse when no grants exist, boot the engine against
    /// the vault (no scaffolding — the sidecar never seeds anything), and
    /// take one baseline snapshot like the app does at launch, so edits made
    /// while nothing was running are attributed to nobody's tool call.
    pub fn open(cfg_dir: PathBuf, vault_root: PathBuf) -> Result<Door, String> {
        if ScopeSet::load(&cfg_dir).is_empty() {
            return Err("no folders are shared (mcp-scopes.json is missing or empty)".into());
        }
        let engine = Engine::new_unconfigured(vault_root);
        debug_assert_ne!(
            cfg_dir, engine.root,
            "MCP grants must stay outside the synced vault"
        );
        let history = match History::new(engine.root.clone()) {
            Ok(h) => {
                if h.is_enabled() {
                    if let Err(e) = h.snapshot("snapshot") {
                        eprintln!("substrate-mcp: baseline snapshot failed: {e}");
                    }
                }
                Some(h)
            }
            Err(e) => {
                eprintln!("substrate-mcp: version history unavailable: {e}");
                None
            }
        };
        // Empty cannot collide with a stored grant (validate_client rejects
        // it), so tools stay closed until a valid initialize request names
        // the exact client. A human-readable sentinel such as "unknown
        // client" could itself be granted in Settings and open the door
        // before protocol initialization.
        Ok(Door { engine, history, cfg_dir, client: String::new() })
    }

    /// Serve newline-delimited JSON-RPC until EOF. Every response is a
    /// single line, flushed immediately — the client blocks on it.
    ///
    /// Three ways a frame can be wrong, one answer each, and the session
    /// survives all of them: malformed bytes and malformed JSON get
    /// `-32700`, a well-formed non-object gets `-32600`. Only EOF or a real
    /// I/O failure ends the loop — a client must never be left waiting on a
    /// reply that will not come.
    pub fn serve<R: BufRead, W: Write>(&mut self, input: R, mut out: W) {
        for line in input.lines() {
            let line = match line {
                Ok(line) => line,
                // A malformed byte sequence is a bad frame, not the end of
                // the conversation: `read_line` has already consumed the
                // offending line, so answering and continuing lands us at
                // the next frame rather than re-reading this one.
                Err(e) if e.kind() == ErrorKind::InvalidData => {
                    let e = rpc_envelope(
                        Value::Null,
                        Err((-32700, "parse error: line is not valid UTF-8".into())),
                    );
                    let _ = writeln!(out, "{e}");
                    let _ = out.flush();
                    continue;
                }
                Err(_) => break,
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(line) else {
                let e = json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": {"code": -32700, "message": "parse error"}
                });
                let _ = writeln!(out, "{e}");
                let _ = out.flush();
                continue;
            };
            if !msg.is_object() {
                let e = rpc_envelope(
                    Value::Null,
                    Err((-32600, "request must be a JSON object".into())),
                );
                let _ = writeln!(out, "{e}");
                let _ = out.flush();
                continue;
            }
            if let Some(resp) = self.handle(&msg) {
                let _ = writeln!(out, "{resp}");
                let _ = out.flush();
            }
        }
    }

    /// One JSON-RPC message in, at most one response out (notifications get
    /// none). Kept `pub(crate)` so tests can drive the protocol directly.
    pub(crate) fn handle(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = match msg.get("method").and_then(Value::as_str) {
            Some(method) => method,
            None => {
                return id.map(|id| {
                    rpc_envelope(id, Err((-32600, "request method is required".into())))
                })
            }
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        // notifications (no id) never get a response, whatever the method
        let id = match id {
            Some(id) if !id.is_null() => id,
            _ => return None,
        };
        let result = match method {
            "initialize" => {
                self.client.clear();
                if let Some(name) =
                    params.get("clientInfo").and_then(|c| c.get("name")).and_then(Value::as_str)
                {
                    // Match the Settings value exactly. Invalid input stays
                    // uninitialized rather than being trimmed/sanitized into
                    // the identity of a different configured client — and it
                    // is not recorded either: the last-seen row is what the
                    // grant pane shows a user deciding whom to trust, so only
                    // names that could ever match a grant get written there.
                    if validate_client(name).is_ok() {
                        lastseen::record(&self.cfg_dir, name);
                        self.client = name.to_string();
                    }
                }
                Ok(json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "substrate-mcp",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => return Some(self.tools_call(id, &params)),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        Some(rpc_envelope(id, result))
    }

    /// `tools/call`: tool-level failures (denied, missing note) are MCP tool
    /// errors — a result with `isError` — while an unknown tool name is a
    /// protocol error. The scope set is re-read here, once per call, so a
    /// revoked grant takes effect on the very next request.
    fn tools_call(&mut self, id: Value, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        // The config file contains every configured client; one stdio process
        // gets only the grants belonging to the name it presented during
        // initialize. The name is self-reported, so the OS user boundary is
        // still the security boundary — this dimension is least-privilege
        // between configured clients, not authentication for a remote peer.
        let scopes = ScopeSet::load(&self.cfg_dir).for_client(&self.client);
        let outcome = match name {
            "vault_list" => self.vault_list(&scopes, &args),
            "note_read" => self.note_read(&scopes, &args),
            "note_write" => self.note_write(&scopes, &args),
            "note_create" => self.note_create(&scopes, &args),
            "vault_search" => self.vault_search(&scopes, &args),
            _ => return rpc_envelope(id, Err((-32602, format!("unknown tool: {name}")))),
        };
        let result = match outcome {
            Ok(v) => json!({
                "content": [{"type": "text", "text": to_pretty(&v)}],
                "isError": false,
            }),
            Err(msg) => json!({
                "content": [{"type": "text", "text": msg}],
                "isError": true,
            }),
        };
        rpc_envelope(id, Ok(result))
    }

    /// Notes and subfolders directly under `folder`. Notes require a read
    /// grant on their own path; a subfolder shows up when it is granted OR
    /// merely on the way to a grant ([`ScopeSet::reveals`]) so the client
    /// can navigate down to what it was actually given.
    fn vault_list(&mut self, scopes: &ScopeSet, args: &Value) -> Result<Value, String> {
        let folder = str_arg(args, "folder").unwrap_or_default();
        if !readable(scopes, &folder) && !scopes.reveals(&folder) {
            return Err(format!("folder is not shared: {folder:?}"));
        }
        // index-derived output → rescan so external edits (the app writing
        // while this sidecar runs) are visible
        self.engine.rescan();
        let notes: Vec<Value> = self
            .engine
            .list()
            .into_iter()
            .filter(|n| n.folder == folder && readable(scopes, &n.path))
            .map(|n| {
                json!({
                    "path": n.path, "title": n.title,
                    "excerpt": n.excerpt, "updated_ms": n.updated_ms,
                })
            })
            .collect();
        let folders: Vec<String> = self
            .engine
            .folders()
            .into_iter()
            .filter(|f| parent_of(f) == folder)
            .filter(|f| readable(scopes, f) || scopes.reveals(f))
            .collect();
        Ok(json!({ "folder": folder, "notes": notes, "folders": folders }))
    }

    fn note_read(&mut self, scopes: &ScopeSet, args: &Value) -> Result<Value, String> {
        let rel = str_arg(args, "path").ok_or("path is required")?;
        // resolved, not just string-level: reading through a symlink must be
        // decided where the bytes actually live
        if !matches!(scopes.decide_resolved(&self.engine.root, &rel), Decision::Allow(_)) {
            return Err(format!("not shared: {rel}"));
        }
        let content = self
            .engine
            .read(&rel)
            .map_err(|_| format!("note unavailable: {rel}"))?;
        let title = self
            .engine
            .meta(&rel)
            .map(|m| m.title)
            .unwrap_or_else(|| Path::new(&rel).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
        Ok(json!({ "path": rel, "title": title, "props": content.props, "body": content.body }))
    }

    fn note_write(&mut self, scopes: &ScopeSet, args: &Value) -> Result<Value, String> {
        let rel = str_arg(args, "path").ok_or("path is required")?;
        let body = str_arg(args, "body").ok_or("body is required")?;
        if scopes.decide_resolved(&self.engine.root, &rel) != Decision::Allow(Access::Write) {
            return Err(format!("not shared for writing: {rel}"));
        }
        self.fence(&rel)?;
        self.engine.write_body(&rel, &body, None)?;
        let receipt = self.receipt("note_write", &rel);
        Ok(json!({ "path": rel, "receipt": receipt }))
    }

    fn note_create(&mut self, scopes: &ScopeSet, args: &Value) -> Result<Value, String> {
        let folder = str_arg(args, "folder").unwrap_or_default();
        let title = str_arg(args, "title").ok_or("title is required")?;
        let note_type = str_arg(args, "type");
        let folder = if folder.trim().is_empty() {
            String::new()
        } else {
            sanitize_folder_rel(&folder)?
        };
        if scopes.decide_resolved(&self.engine.root, &folder) != Decision::Allow(Access::Write) {
            return Err(format!("folder is not shared for writing: {folder:?}"));
        }
        // A write grant on the folder is not the whole decision: the note's
        // own path can land on a surface no grant may write (a root
        // `AGENTS.md`, a dot-name) or on a symlink planted under the folder
        // that resolves outside the vault. Decide the destination the engine
        // would pick — `first_note_rel` is the same derivation `create` uses —
        // before anything is written.
        let candidate = first_note_rel(&folder, &title);
        if scopes.decide_resolved(&self.engine.root, &candidate) != Decision::Allow(Access::Write) {
            return Err(format!("not shared for writing: {candidate}"));
        }
        let meta = self.engine.create(&title, &folder, note_type.as_deref())?;
        let receipt = self.receipt("note_create", &meta.path);
        Ok(json!({ "path": meta.path, "title": meta.title, "receipt": receipt }))
    }

    /// Search, filtered to granted prefixes BEFORE the query runs: the
    /// allow-list is pushed into the engine as its `scope`, so ungranted
    /// folders can never leak titles or snippets — not even as a rank-N
    /// entry that got trimmed from a capped page.
    fn vault_search(&mut self, scopes: &ScopeSet, args: &Value) -> Result<Value, String> {
        let query = str_arg(args, "query").ok_or("query is required")?;
        self.engine.rescan();
        let allowed: Vec<String> = self
            .engine
            .list()
            .into_iter()
            .map(|n| n.path)
            .filter(|p| readable(scopes, p))
            .collect();
        let hits: Vec<Value> = self
            .engine
            .search(&query, Some(&allowed), true)
            .into_iter()
            .map(|h| json!({ "path": h.path, "snippet": h.snippet }))
            .collect();
        Ok(json!({ "query": query, "hits": hits }))
    }


    /// Fence off uncommitted user edits to `rel` under the app's normal
    /// identity before an MCP write touches it. A fence that FAILS aborts
    /// the write: attribution integrity outranks the edit — an MCP commit
    /// that swallowed a user's edit would poison receipts permanently.
    ///
    /// Fence, write, and receipt are three separate steps, and the app's own
    /// auto-snapshot runs in another process against the same repo. A
    /// snapshot landing in either gap absorbs the bytes under the normal
    /// identity: the content is never lost, but the MCP authorship is —
    /// [`Door::receipt`] reports that no attributable change remained rather
    /// than claiming a clean receipt. Closing the window needs a history
    /// lock both the app and the sidecar take; that is phase-2 work and is
    /// tracked with the remote transport, not papered over here.
    fn fence(&self, rel: &str) -> Result<(), String> {
        // nothing on disk = nothing of the user's to fence (the write itself
        // will refuse a missing note); also keeps `git add` off a pathspec
        // that matches nothing, which errors instead of no-oping
        if !self.engine.root.join(rel).is_file() {
            return Ok(());
        }
        match &self.history {
            Some(h) if h.is_enabled() => h
                .commit_paths_as(&[rel], "Substrate", "substrate@local", FENCE_LABEL)
                .map(|_| ())
                .map_err(|e| format!("history fence failed, write refused: {e}")),
            _ => Ok(()),
        }
    }

    /// Commit one written path as `Substrate MCP <mcp@local>`, client name in
    /// the message. The write has already landed when this runs, so failures
    /// are reported in the receipt string rather than failing the call.
    fn receipt(&self, tool: &str, rel: &str) -> String {
        match &self.history {
            None => "history unavailable — write not snapshotted".into(),
            Some(h) if !h.is_enabled() => {
                "vault history is the user's own repository — write not snapshotted".into()
            }
            Some(h) => {
                let msg = format!("mcp: {tool} {rel} ({})", self.client);
                match h.commit_paths_as(&[rel], MCP_AUTHOR_NAME, MCP_AUTHOR_EMAIL, &msg) {
                    Ok(true) => format!("committed as {MCP_AUTHOR_NAME} <{MCP_AUTHOR_EMAIL}>"),
                    Ok(false) => {
                        "no attributable change remained — another history snapshot may have captured the write"
                            .into()
                    }
                    Err(e) => format!("write landed but the receipt commit failed: {e}"),
                }
            }
        }
    }
}

/// Read access at the string level — used for filtering index rows (list,
/// search), which never touch the disk per row. Writes and reads of actual
/// file content go through `decide_resolved` instead.
fn readable(scopes: &ScopeSet, rel: &str) -> bool {
    matches!(scopes.decide_rel(rel), Decision::Allow(_))
}

fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn to_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
}

fn rpc_envelope(id: Value, result: Result<Value, (i64, String)>) -> Value {
    match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    }
}


fn tool_definitions() -> Value {
    let obj = |props: Value, required: &[&str]| {
        json!({"type": "object", "properties": props, "required": required})
    };
    json!([
        {
            "name": "vault_list",
            "description": "List notes and subfolders directly under a shared vault folder. Paths are vault-relative; \"\" is the vault root.",
            "inputSchema": obj(json!({
                "folder": {"type": "string", "description": "Vault-relative folder, \"\" for the root"}
            }), &[]),
        },
        {
            "name": "note_read",
            "description": "Read one note: its properties (frontmatter) and Markdown body.",
            "inputSchema": obj(json!({
                "path": {"type": "string", "description": "Vault-relative note path, e.g. Notes/Idea.md"}
            }), &["path"]),
        },
        {
            "name": "note_write",
            "description": "Replace a note's Markdown body (properties are preserved). Requires a write grant.",
            "inputSchema": obj(json!({
                "path": {"type": "string"},
                "body": {"type": "string", "description": "The full new Markdown body"}
            }), &["path", "body"]),
        },
        {
            "name": "note_create",
            "description": "Create a new note in a shared folder. Requires a write grant.",
            "inputSchema": obj(json!({
                "folder": {"type": "string", "description": "Vault-relative folder, \"\" for the root"},
                "title": {"type": "string"},
                "type": {"type": "string", "description": "Optional note type"}
            }), &["title"]),
        },
        {
            "name": "vault_search",
            "description": "Full-text search across the shared folders. Results never include unshared folders.",
            "inputSchema": obj(json!({
                "query": {"type": "string"}
            }), &["query"]),
        },
    ])
}

/// The bundle identifier, read from the embedded `tauri.conf.json` rather
/// than repeated as a literal — one source of truth, and a build whose conf
/// carries a different identifier (the public mirror rewrites it) stays
/// consistent without touching this file.
fn bundle_identifier() -> Option<String> {
    let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).ok()?;
    conf.get("identifier").and_then(Value::as_str).map(str::to_string)
}

/// The sidecar's config dir — must be the SAME directory the app's
/// `app_config_dir()` resolves to, since that is where the app's grant UI
/// writes `mcp-scopes.json` and `config.json`. The sidecar has no Tauri
/// handle, so the platform paths are mirrored here.
/// `SUBSTRATE_CONFIG_DIR` overrides for tests and dev runs.
pub(super) fn config_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("SUBSTRATE_CONFIG_DIR") {
        if !d.is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    let ident = bundle_identifier()?;
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support").join(ident))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(ident))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map(|d| d.join(ident))
    }
}

/// Same resolution order as the app (`appcfg::resolve_vault`): `VAULT_DIR`
/// env, then the stored choice, then an existing `~/Vault`. First run —
/// no vault anywhere — is a refusal: the sidecar never picks a vault.
pub(super) fn resolve_root(cfg_dir: &Path) -> Option<PathBuf> {
    let env_vault = std::env::var("VAULT_DIR").ok();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    match crate::appcfg::resolve_vault(cfg_dir, env_vault.as_deref(), &home.join("Vault")) {
        crate::appcfg::Resolution::Root(root, _) => Some(root),
        crate::appcfg::Resolution::FirstRun => None,
    }
}

/// Entry point for the `substrate-mcp` binary. Returns the process exit
/// code; the door-closed and no-vault cases exit non-zero BEFORE serving,
/// so a client spawning the sidecar without grants sees a dead process,
/// not a server that denies everything.
pub fn run() -> i32 {
    let Some(cfg_dir) = config_dir() else {
        eprintln!("substrate-mcp: could not resolve the config directory");
        return 3;
    };
    if ScopeSet::load(&cfg_dir).is_empty() {
        eprintln!(
            "substrate-mcp: no folders are shared — the door stays closed (grant folders in Substrate first; {} in {})",
            super::scope::SCOPES_FILE,
            cfg_dir.display()
        );
        return 2;
    }
    let Some(root) = resolve_root(&cfg_dir) else {
        eprintln!("substrate-mcp: no vault is configured on this machine");
        return 3;
    };
    let mut door = match Door::open(cfg_dir, root) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("substrate-mcp: {e}");
            return 2;
        }
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    door.serve(stdin.lock(), stdout.lock());
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcpdoor::scope::Grant;
    use std::fs;

    fn write_scopes(cfg: &Path, grants: &[(&str, Access)]) {
        let set = ScopeSet {
            grants: grants
                .iter()
                .map(|(p, a)| Grant::folder("TestClient", p, *a))
                .collect(),
            extra: Default::default(),
        };
        set.save(cfg).unwrap();
    }

    /// A vault with granted and ungranted corners, plus a Door over it.
    fn setup(name: &str, grants: &[(&str, Access)]) -> (Door, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("mcp-door-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("vault");
        let cfg = base.join("cfg");
        fs::create_dir_all(root.join("Notes/Sub")).unwrap();
        fs::create_dir_all(root.join("Finance")).unwrap();
        fs::write(root.join("Notes/a.md"), "---\ntype: note\n---\nalpha body\n").unwrap();
        fs::write(root.join("Notes/Sub/b.md"), "beta body\n").unwrap();
        fs::write(root.join("Finance/f.md"), "secret ledger\n").unwrap();
        fs::write(root.join("Root.md"), "root note\n").unwrap();
        fs::write(root.join("Settings.md"), "config surface\n").unwrap();
        fs::write(root.join("AGENTS.md"), "house rules\n").unwrap();
        write_scopes(&cfg, grants);
        let mut door = Door::open(cfg.clone(), root.clone()).unwrap();
        door.client = "TestClient".into();
        (door, root, cfg)
    }

    fn git_out(root: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn door_refuses_to_open_without_grants() {
        let base =
            std::env::temp_dir().join(format!("mcp-door-{}-closed", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("vault");
        let cfg = base.join("cfg");
        fs::create_dir_all(&root).unwrap();
        // missing file and explicitly-empty file both keep the door shut
        assert!(Door::open(cfg.clone(), root.clone()).is_err());
        write_scopes(&cfg, &[]);
        assert!(Door::open(cfg, root).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_shows_granted_notes_and_reveals_the_path_to_grants() {
        let (mut door, _root, _cfg) = setup("list", &[("Notes/Sub", Access::Read)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        // root: no notes readable, but "Notes" is revealed as the way down
        let v = door.vault_list(&scopes, &json!({"folder": ""})).unwrap();
        assert!(v["notes"].as_array().unwrap().is_empty(), "no root notes leak: {v}");
        assert_eq!(v["folders"], json!(["Notes"]));
        // Notes: a.md is NOT granted, Sub is
        let v = door.vault_list(&scopes, &json!({"folder": "Notes"})).unwrap();
        assert!(v["notes"].as_array().unwrap().is_empty());
        assert_eq!(v["folders"], json!(["Notes/Sub"]));
        let v = door.vault_list(&scopes, &json!({"folder": "Notes/Sub"})).unwrap();
        let notes = v["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["path"], "Notes/Sub/b.md");
        // an unrelated folder is a refusal, not an empty listing
        assert!(door.vault_list(&scopes, &json!({"folder": "Finance"})).is_err());
    }

    #[test]
    fn read_respects_grants_and_hard_denials() {
        let (mut door, root, _cfg) = setup("read", &[("", Access::Read)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        let v = door.note_read(&scopes, &json!({"path": "Notes/a.md"})).unwrap();
        assert_eq!(v["body"], "alpha body\n");
        assert_eq!(v["props"]["type"], "note");
        // root grant still never exposes the config surface
        assert!(door.note_read(&scopes, &json!({"path": "Settings.md"})).is_err());
        assert!(door.note_read(&scopes, &json!({"path": ".vault/folders.json"})).is_err());
        let missing = door
            .note_read(&scopes, &json!({"path": "Notes/missing.md"}))
            .unwrap_err();
        assert_eq!(missing, "note unavailable: Notes/missing.md");
        assert!(!missing.contains(&root.to_string_lossy().to_string()));
    }

    #[test]
    fn write_needs_a_write_grant() {
        let (mut door, root, _cfg) = setup("wgrant", &[("Notes", Access::Read)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        let err = door
            .note_write(&scopes, &json!({"path": "Notes/a.md", "body": "hacked"}))
            .unwrap_err();
        assert!(err.contains("not shared for writing"), "{err}");
        assert!(!fs::read_to_string(root.join("Notes/a.md")).unwrap().contains("hacked"));
    }

    #[test]
    fn write_lands_and_commits_as_the_mcp_identity() {
        let (mut door, root, _cfg) = setup("wcommit", &[("Notes", Access::Write)]);
        door.client = "Claude Desktop".into();
        let scopes = ScopeSet::load(&door.cfg_dir);
        let v = door
            .note_write(&scopes, &json!({"path": "Notes/a.md", "body": "rewritten\n"}))
            .unwrap();
        assert!(v["receipt"].as_str().unwrap().contains("Substrate MCP"), "{v}");
        let raw = fs::read_to_string(root.join("Notes/a.md")).unwrap();
        assert!(raw.contains("rewritten") && raw.contains("type: note"), "props kept: {raw}");
        let log = git_out(&root, &["log", "--format=%an <%ae> %s", "--", "Notes/a.md"]);
        let head = log.lines().next().unwrap();
        assert!(
            head.contains("Substrate MCP <mcp@local>")
                && head.contains("note_write Notes/a.md (Claude Desktop)"),
            "attributed with client name: {head}"
        );
    }

    #[test]
    fn dirty_user_edit_is_fenced_before_the_mcp_commit() {
        let (mut door, root, _cfg) = setup("fence", &[("Notes", Access::Write)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        // a user edit after the baseline snapshot, uncommitted
        fs::write(root.join("Notes/a.md"), "---\ntype: note\n---\nuser edit\n").unwrap();
        door.note_write(&scopes, &json!({"path": "Notes/a.md", "body": "mcp edit\n"})).unwrap();
        let log = git_out(&root, &["log", "--format=%an|%s", "--", "Notes/a.md"]);
        let lines: Vec<&str> = log.lines().collect();
        assert!(lines[0].starts_with("Substrate MCP|"), "{log}");
        assert_eq!(lines[1], format!("Substrate|{FENCE_LABEL}"), "{log}");
        // the fence commit holds the USER'S text, not the MCP text
        let fence_id = git_out(&root, &["log", "--format=%H", "-2", "--", "Notes/a.md"]);
        let fence_id = fence_id.lines().nth(1).unwrap();
        let fenced = git_out(&root, &["show", &format!("{fence_id}:Notes/a.md")]);
        assert!(fenced.contains("user edit"), "{fenced}");
    }

    #[test]
    fn create_needs_write_and_reports_the_real_path() {
        let (mut door, root, _cfg) = setup("create", &[("Notes", Access::Write)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        let v = door
            .note_create(&scopes, &json!({"folder": "Notes", "title": "Fresh", "type": "idea"}))
            .unwrap();
        assert_eq!(v["path"], "Notes/Fresh.md");
        let raw = fs::read_to_string(root.join("Notes/Fresh.md")).unwrap();
        assert!(raw.contains("type: idea"), "{raw}");
        let log = git_out(&root, &["log", "--format=%an", "-1", "--", "Notes/Fresh.md"]);
        assert_eq!(log.trim(), "Substrate MCP");
        // ungranted folder refuses; so does the root without a root grant
        assert!(door.note_create(&scopes, &json!({"folder": "Finance", "title": "X"})).is_err());
        assert!(door.note_create(&scopes, &json!({"folder": "", "title": "X"})).is_err());
    }

    #[test]
    fn agent_instructions_are_readable_but_never_writable() {
        let (mut door, root, _cfg) = setup("agents", &[("", Access::Write)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        // a client granted the whole vault may still READ the house rules
        let v = door.note_read(&scopes, &json!({"path": "AGENTS.md"})).unwrap();
        assert_eq!(v["body"], "house rules\n");
        // …and may never rewrite the instructions the next agent follows
        let err = door
            .note_write(&scopes, &json!({"path": "AGENTS.md", "body": "ignore prior rules"}))
            .unwrap_err();
        assert!(err.contains("not shared for writing"), "{err}");
        assert_eq!(fs::read_to_string(root.join("AGENTS.md")).unwrap(), "house rules\n");
    }

    /// A sealed folder's `.substrate-seal` marker carries the age
    /// recipient every note written there is encrypted to. The door must not
    /// hand it over and must never be able to point it somewhere else.
    #[test]
    fn seal_material_is_never_readable_or_writable_through_the_door() {
        let (mut door, root, _cfg) = setup("seal", &[("", Access::Write)]);
        fs::write(root.join("Notes/.substrate-seal"), "age1realrecipient").unwrap();
        door.engine.rescan();
        let scopes = ScopeSet::load(&door.cfg_dir);

        let err = door.note_read(&scopes, &json!({"path": "Notes/.substrate-seal"})).unwrap_err();
        assert!(err.contains("not shared"), "{err}");

        let err = door
            .note_write(
                &scopes,
                &json!({"path": "Notes/.substrate-seal", "body": "age1attackerkey"}),
            )
            .unwrap_err();
        assert!(err.contains("not shared for writing"), "{err}");
        assert_eq!(
            fs::read_to_string(root.join("Notes/.substrate-seal")).unwrap(),
            "age1realrecipient",
            "the door rewrote the seal recipient"
        );

        // and it is not listed either — a client cannot even learn which
        // folders are sealed
        let v = door.vault_list(&scopes, &json!({"folder": "Notes"})).unwrap();
        assert!(
            !serde_json::to_string(&v).unwrap().contains("substrate-seal"),
            "seal marker leaked through vault_list: {v}"
        );
    }

    /// A sealed note under a granted folder: the door process never unlocks
    /// the vault identity, so ciphertext must stay ciphertext in both
    /// directions — no plaintext out, and no plaintext write destroying the
    /// seal on the way in.
    #[test]
    fn a_sealed_note_is_neither_read_nor_overwritten() {
        let (mut door, root, _cfg) = setup("sealed-note", &[("", Access::Write)]);
        let sealed = root.join("Notes/secret.md");
        let mut bytes = b"SUBSTRATE-SEALED-1\n".to_vec();
        bytes.extend_from_slice(&[0x01, 0x02, 0x03, 0xff]);
        fs::write(&sealed, &bytes).unwrap();
        door.engine.rescan();
        let scopes = ScopeSet::load(&door.cfg_dir);

        // the grant covers it, but the engine refuses to decrypt for a
        // process that holds no identity
        let err = door.note_read(&scopes, &json!({"path": "Notes/secret.md"})).unwrap_err();
        assert!(err.contains("unavailable"), "{err}");

        let err = door
            .note_write(&scopes, &json!({"path": "Notes/secret.md", "body": "plain"}))
            .unwrap_err();
        assert!(err.contains("sealed"), "{err}");
        assert_eq!(fs::read(&sealed).unwrap(), bytes, "the seal was overwritten");
    }

    #[test]
    fn create_cannot_author_an_instruction_surface() {
        let (mut door, root, _cfg) = setup("agents-create", &[("", Access::Write)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        // with the file absent, the folder grant alone would have let the
        // create land on it — the destination check is what refuses
        fs::remove_file(root.join("AGENTS.md")).unwrap();
        door.engine.rescan();
        let err = door
            .note_create(&scopes, &json!({"folder": "", "title": "AGENTS"}))
            .unwrap_err();
        assert!(err.contains("not shared for writing"), "{err}");
        assert!(!root.join("AGENTS.md").exists(), "instruction surface was authored");
        // an ordinary root note under the same grant still works
        assert!(door.note_create(&scopes, &json!({"folder": "", "title": "Ordinary"})).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_not_a_writable_target() {
        let (mut door, root, _cfg) = setup("dangling", &[("Notes", Access::Write)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        // the classic shape: a note-looking name inside the grant pointing at
        // a file that does not exist YET, outside the vault
        let outside = root.parent().unwrap().join("authorized_keys");
        std::os::unix::fs::symlink(&outside, root.join("Notes/keys.md")).unwrap();
        // the decision itself, not just the engine's own missing-file
        // refusal: a dangling link must never be mistaken for a free name a
        // create may take, or the target inherits the grant once it appears
        assert_eq!(
            scopes.decide_resolved(&door.engine.root, "Notes/keys.md"),
            Decision::Deny
        );
        assert!(door
            .note_write(&scopes, &json!({"path": "Notes/keys.md", "body": "ssh-rsa AAAA"}))
            .is_err());
        assert!(door.note_read(&scopes, &json!({"path": "Notes/keys.md"})).is_err());
        assert!(!outside.exists(), "the write escaped the vault through the link");
    }

    #[test]
    fn create_checks_the_sanitized_destination_against_the_grant() {
        let (mut door, root, _cfg) = setup("create-sanitized", &[("Notes:Private", Access::Write)]);
        let scopes = ScopeSet::load(&door.cfg_dir);

        assert!(door
            .note_create(&scopes, &json!({"folder": "Notes:Private", "title": "Outside"}))
            .is_err());
        assert!(!root.join("Notes Private/Outside.md").exists());
    }

    #[test]
    fn search_never_leaks_ungranted_folders() {
        let (mut door, _root, _cfg) = setup("search", &[("Notes", Access::Read)]);
        let scopes = ScopeSet::load(&door.cfg_dir);
        // "body" matches Notes/a.md, Notes/Sub/b.md AND Finance/f.md ("secret
        // ledger\n" doesn't) — use a term that hits both sides of the fence
        let v = door.vault_search(&scopes, &json!({"query": "secret"})).unwrap();
        assert!(v["hits"].as_array().unwrap().is_empty(), "ungranted content leaked: {v}");
        let v = door.vault_search(&scopes, &json!({"query": "body"})).unwrap();
        let paths: Vec<&str> =
            v["hits"].as_array().unwrap().iter().map(|h| h["path"].as_str().unwrap()).collect();
        assert!(paths.contains(&"Notes/a.md") && paths.contains(&"Notes/Sub/b.md"), "{paths:?}");
        assert!(!paths.iter().any(|p| p.starts_with("Finance")), "{paths:?}");
    }


    #[test]
    fn revoking_a_grant_takes_effect_on_the_next_call() {
        let (mut door, _root, cfg) = setup("revoke", &[("Notes", Access::Write)]);
        let msg = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "note_read", "arguments": {"path": "Notes/a.md"}}
        });
        let resp = door.handle(&msg).unwrap();
        assert_eq!(resp["result"]["isError"], false, "{resp}");
        // revoke by emptying the file — no restart
        fs::write(cfg.join(crate::mcpdoor::scope::SCOPES_FILE), "{\"grants\":[]}\n").unwrap();
        let resp = door.handle(&msg).unwrap();
        assert_eq!(resp["result"]["isError"], true, "revoked grant still served: {resp}");
    }

    #[test]
    fn one_clients_grants_never_flow_to_another_client() {
        let (mut door, _root, _cfg) = setup("clients", &[("Notes", Access::Read)]);
        let call = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "note_read", "arguments": {"path": "Notes/a.md"}}
        });
        assert_eq!(door.handle(&call).unwrap()["result"]["isError"], false);

        let init = json!({
            "jsonrpc":"2.0", "id":2, "method":"initialize",
            "params":{"clientInfo":{"name":"OtherClient","version":"1"}}
        });
        door.handle(&init).unwrap();
        let denied = door.handle(&call).unwrap();
        assert_eq!(denied["result"]["isError"], true, "cross-client grant leaked: {denied}");
    }

    #[test]
    fn tools_stay_closed_until_an_exact_valid_client_initializes() {
        let (mut door, _root, cfg) = setup("client-init", &[("Notes", Access::Read)]);
        door.client.clear();
        let call = json!({
            "jsonrpc":"2.0", "id":1, "method":"tools/call",
            "params":{"name":"note_read", "arguments":{"path":"Notes/a.md"}}
        });
        assert_eq!(door.handle(&call).unwrap()["result"]["isError"], true);

        let padded = json!({
            "jsonrpc":"2.0", "id":2, "method":"initialize",
            "params":{"clientInfo":{"name":" TestClient ","version":"1"}}
        });
        door.handle(&padded).unwrap();
        assert!(door.client.is_empty(), "invalid input was normalized into a grant identity");
        assert_eq!(door.handle(&call).unwrap()["result"]["isError"], true);
        // A name that can never match a grant does not get written to the row
        // the grant pane renders: that row is a trust surface, not a log of
        // whatever bytes a local process sent.
        assert!(
            super::lastseen::load(&cfg).is_none(),
            "an invalid client name reached the file the grant pane shows"
        );

        let exact = json!({
            "jsonrpc":"2.0", "id":3, "method":"initialize",
            "params":{"clientInfo":{"name":"TestClient","version":"1"}}
        });
        door.handle(&exact).unwrap();
        assert_eq!(door.handle(&call).unwrap()["result"]["isError"], false);
        assert_eq!(super::lastseen::load(&cfg).unwrap().name, "TestClient");

        door.handle(&padded).unwrap();
        assert!(door.client.is_empty(), "invalid re-initialize retained the prior grant identity");
        assert_eq!(door.handle(&call).unwrap()["result"]["isError"], true);
        assert_eq!(
            super::lastseen::load(&cfg).unwrap().name,
            "TestClient",
            "an invalid re-initialize overwrote the last valid client in the pane"
        );
    }

    #[test]
    fn protocol_smoke_over_the_wire_shape() {
        let (mut door, _root, _cfg) = setup("proto", &[("Notes", Access::Read)]);
        let input = [
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"TestClient","version":"1.0"}}}).to_string(),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}).to_string(),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vault_list","arguments":{"folder":"Notes"}}}).to_string(),
            json!({"jsonrpc":"2.0","id":3,"method":"nope"}).to_string(),
        ]
        .join("\n");
        let mut out = Vec::new();
        door.serve(input.as_bytes(), &mut out);
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        // 4 responses: the notification gets none
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert_eq!(lines[0]["result"]["serverInfo"]["name"], "substrate-mcp");
        assert_eq!(door.client, "TestClient");
        let tools = lines[1]["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "vault_list",
                "note_read",
                "note_write",
                "note_create",
                "vault_search"
            ]
        );
        assert_eq!(lines[2]["result"]["isError"], false, "{:?}", lines[2]);
        assert_eq!(lines[3]["error"]["code"], -32601);
    }

    #[test]
    fn invalid_requests_receive_an_error_instead_of_hanging() {
        let (mut door, _root, _cfg) = setup("proto-invalid", &[("Notes", Access::Read)]);
        let input = [
            json!({"jsonrpc":"2.0","id":9}).to_string(),
            json!([{"jsonrpc":"2.0","id":10,"method":"ping"}]).to_string(),
            json!(5).to_string(),
        ]
        .join("\n");
        let mut out = Vec::new();

        door.serve(input.as_bytes(), &mut out);

        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["id"], 9);
        assert_eq!(lines[0]["error"]["code"], -32600);
        assert_eq!(lines[1]["id"], Value::Null);
        assert_eq!(lines[1]["error"]["code"], -32600);
        assert_eq!(lines[2]["id"], Value::Null);
        assert_eq!(lines[2]["error"]["code"], -32600);
    }

    #[test]
    fn a_malformed_byte_sequence_is_answered_and_the_session_continues() {
        let (mut door, _root, _cfg) = setup("proto-bytes", &[("Notes", Access::Read)]);
        let mut input: Vec<u8> = Vec::new();
        input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n");
        // a lone continuation byte: no valid UTF-8 sequence starts with it
        input.extend_from_slice(&[0x7b, 0xff, 0xfe, 0x7d]);
        input.push(b'\n');
        input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n");
        let mut out = Vec::new();

        door.serve(&input[..], &mut out);

        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        // the bad bytes cost exactly one frame — the request after them is served
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[1]["id"], Value::Null);
        assert_eq!(lines[1]["error"]["code"], -32700);
        assert_eq!(lines[2]["id"], 2);
        assert!(lines[2]["result"]["tools"].is_array(), "{:?}", lines[2]);
    }

    #[test]
    fn symlink_escape_is_refused_at_the_tool_layer() {
        #[cfg(unix)]
        {
            let (mut door, root, _cfg) = setup("symlink", &[("Notes", Access::Write)]);
            let scopes = ScopeSet::load(&door.cfg_dir);
            std::os::unix::fs::symlink(root.join("Finance"), root.join("Notes/fin")).unwrap();
            assert!(door.note_read(&scopes, &json!({"path": "Notes/fin/f.md"})).is_err());
            assert!(door
                .note_write(&scopes, &json!({"path": "Notes/fin/f.md", "body": "x"}))
                .is_err());
            assert_eq!(
                fs::read_to_string(root.join("Finance/f.md")).unwrap(),
                "secret ledger\n"
            );
        }
    }
}
