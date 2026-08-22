//! MCP door scope engine — the permission core.
//!
//! Nothing here listens, spawns, or registers a Tauri command. This module is
//! the part that has to be right regardless of transport: which paths a
//! grant set exposes, at what access level, with escapes (symlinks, `..`,
//! absolute paths) closed.
//!
//! Grants live in `mcp-scopes.json` in the app config dir — deliberately
//! per-machine, next to `config.json` (see `appcfg.rs` for why config that
//! *grants access* must never ride inside a synced vault). A missing file is
//! an empty scope set, and an empty scope set means the door is closed:
//! default-off is the absence of grants, not a flag.
//!
//! Production callers: the phase-1 stdio server (`super::server`) reads it per
//! call; the Settings command layer (`commands::mcp`) owns user-visible grant
//! writes and revokes.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

/// `mcp-scopes.json` inside the app-config dir.
pub const SCOPES_FILE: &str = "mcp-scopes.json";

/// Access level of a grant. `Write` implies read; there is deliberately no
/// delete level in v1 — trash semantics are a separate call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Write,
}

/// One grant: a vault-relative folder prefix (`""` = whole vault, otherwise
/// e.g. `"Notes"` or `"Music/Sketches"`, no leading/trailing slash) plus the
/// level it opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// Exact `initialize.clientInfo.name` this grant belongs to. stdio client
    /// names are self-reported (the OS-user boundary remains the real auth),
    /// but keeping them here prevents one configured client from silently
    /// inheriting another client's folder list.
    pub client: String,
    pub prefix: String,
    pub access: Access,
    /// A newer transport may need a stable subject or transport metadata.
    /// Keep fields this build does not know so a Settings edit never erases
    /// that future data from the per-machine grant file.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Grant {
    /// A folder grant — the only kind the Settings picker writes, and the
    /// shape every caller outside this module builds. Constructed here so a
    /// field this build may not carry has exactly one place to be set.
    pub fn folder(client: &str, prefix: &str, access: Access) -> Self {
        Self {
            client: client.to_string(),
            prefix: prefix.to_string(),
            access,
            extra: BTreeMap::new(),
        }
    }

}

/// The whole grant set for this machine. Unknown keys in the file are
/// preserved-by-ignoring, same posture as `AppConfig`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeSet {
    #[serde(default)]
    pub grants: Vec<Grant>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// What the engine decided for one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Deny,
    Allow(Access),
}

/// Root files no grant may ever expose. Leading-dot segments are denied
/// separately by [`is_hard_denied`], covering `.vault`, `.git`, and future
/// app/tool metadata without an allowlist that can drift.
const ROOT_HARD_DENY: &[&str] = &["Settings.md"];

/// Root files a grant may read but never write: the agent-instruction
/// surfaces. Reading them is how a well-behaved client learns the vault's
/// conventions; writing them would let a steerable client author the
/// instructions the NEXT agent follows — an injection foothold that outlives
/// the session and is invisible in the note the user is looking at.
///
/// Deliberately not configurable here: fail-closed is the phase-1 default,
/// and the grant pane owns any future per-grant relax.
const ROOT_WRITE_DENY: &[&str] = &["AGENTS.md", "CLAUDE.md"];

impl ScopeSet {
    /// Read the scope set; a missing or unparsable file is an empty set —
    /// the door fails closed, never open.
    ///
    /// Grants `save` would have rejected are dropped rather than honoured.
    /// A hand-edited file is the only way one can exist, and the shape that
    /// matters is an empty client name: a caller whose own name fails
    /// validation is left holding the empty name too, and would otherwise
    /// match such a grant exactly. Deciding reads the loaded set, editing
    /// reads the raw file — so Settings still SHOWS such a row instead of
    /// silently erasing it, and no decision ever honours it.
    ///
    /// Showing is not round-tripping: `save` validates what is still in the
    /// set, so while an invalid row sits in the file, adding a grant and
    /// revoking a *valid* row fail with that row's error — but revoking the
    /// invalid row itself succeeds once it is the last invalid one, and
    /// Revoke all always succeeds, because both drop rows before saving.
    /// Visible-and-inert is the deliberate half; a pane restricted to
    /// removal is the price, and the door staying shut is the right side to
    /// fail on.
    pub fn load(cfg_dir: &Path) -> Self {
        let mut set = Self::load_for_edit(cfg_dir).unwrap_or_default();
        set.grants.retain(|g| {
            validate_client(&g.client).is_ok() && validate_prefix(&g.prefix).is_ok()
        });
        set
    }

    /// Read for a Settings mutation. The server deliberately turns corrupt
    /// config into an empty, closed door; an editor must instead report the
    /// corruption so clicking “grant” cannot erase the unreadable file.
    pub(crate) fn load_for_edit(cfg_dir: &Path) -> Result<Self, String> {
        match fs::read_to_string(cfg_dir.join(SCOPES_FILE)) {
            Ok(raw) => {
                serde_json::from_str(&raw).map_err(|e| format!("couldn't read {SCOPES_FILE}: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("couldn't read {SCOPES_FILE}: {e}")),
        }
    }

    /// Persist the scope set, creating the config dir if needed. Rejects
    /// malformed prefixes rather than storing a grant whose meaning would
    /// depend on later normalization.
    pub fn save(&self, cfg_dir: &Path) -> Result<(), String> {
        for g in &self.grants {
            validate_client(&g.client)?;
            validate_prefix(&g.prefix)?;
        }
        fs::create_dir_all(cfg_dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(cfg_dir.join(SCOPES_FILE), format!("{json}\n")).map_err(|e| e.to_string())
    }

    /// True when no grant exists at all — the caller can skip starting any
    /// server in the first place.
    pub fn is_empty(&self) -> bool {
        self.grants.is_empty()
    }

    /// The effective scope for one initialized MCP client. Matching is exact:
    /// the value shown in Settings is the value the client must report.
    pub fn for_client(&self, client: &str) -> Self {
        ScopeSet {
            grants: self.grants.iter().filter(|g| g.client == client).cloned().collect(),
            extra: self.extra.clone(),
        }
    }

    /// Decide access for a vault-relative path, on the path STRING alone.
    /// The most permissive covering grant wins; absence of a grant is the
    /// deny (no deny-overrides — grants only widen). The one ceiling on top
    /// of that is [`ROOT_WRITE_DENY`], which caps the agent-instruction
    /// surfaces at read no matter how wide the grant.
    ///
    /// String-level only: callers holding a real filesystem path must go
    /// through [`decide_resolved`], which also closes symlink escapes. This
    /// half is separate only so list/search can filter INDEX-DERIVED relative
    /// paths without touching the disk per row. It is not a gate for raw
    /// client input; content reads/writes must use [`decide_resolved`].
    pub fn decide_rel(&self, rel: &str) -> Decision {
        let Some(rel) = normalize_rel(rel) else {
            return Decision::Deny;
        };
        if is_hard_denied(&rel) {
            return Decision::Deny;
        }
        let ceiling = if is_write_denied(&rel) { Access::Read } else { Access::Write };
        self.grants
            .iter()
            .filter(|g| {
                normalize_rel(&g.prefix).is_some_and(|p| covers(&p, &rel))
            })
            .map(|g| g.access.min(ceiling))
            .max()
            .map_or(Decision::Deny, Decision::Allow)
    }

    /// Whether `rel` sits ON THE WAY to some grant — a strict-or-equal
    /// ancestor of a granted prefix. Lets a client navigate down from the
    /// vault root to the folders it was given (`vault_list` shows such
    /// folders as bare names) without exposing anything beside the path:
    /// contents still need their own covering grant.
    pub fn reveals(&self, rel: &str) -> bool {
        let Some(rel) = normalize_rel(rel) else {
            return false;
        };
        if is_hard_denied(&rel) {
            return false;
        }
        self.grants
            .iter()
            .any(|g| normalize_rel(&g.prefix).is_some_and(|p| covers(&rel, &p)))
    }

    /// Decide access for a path that will actually be touched on disk.
    /// Canonicalizes what exists (for a not-yet-existing target, its parent —
    /// creation is a legitimate write) and requires the RESOLVED location to
    /// still sit under the vault root and under a granted prefix. This is
    /// what makes a symlink planted inside a granted folder useless as an
    /// escape hatch: the grant is checked where the bytes would land, not
    /// where the request pointed.
    ///
    /// This decision and the caller's filesystem operation are not atomic.
    /// Callers must perform the operation immediately and keep errors
    /// fail-closed; a future long-lived/remote transport needs an fd-relative
    /// open primitive before it can claim a race-free boundary.
    pub fn decide_resolved(&self, vault_root: &Path, rel: &str) -> Decision {
        // the string-level gate runs first, so `..`, absolute paths and
        // hard-denied names never even reach the filesystem
        if self.decide_rel(rel) == Decision::Deny {
            return Decision::Deny;
        }
        let Ok(root) = vault_root.canonicalize() else {
            return Decision::Deny;
        };
        let requested = root.join(rel);
        let resolved = match requested.canonicalize() {
            Ok(p) => p,
            // target doesn't exist yet (a create): resolve the parent and
            // re-attach the final name; a missing parent is a deny, not a
            // mkdir-p — the door does not invent directories
            Err(_) => {
                // Only a genuinely absent leaf is eligible for the create
                // path. A dangling symlink has metadata even though
                // canonicalize fails; treating it as a missing file would
                // let a later-created outside target inherit this grant.
                match fs::symlink_metadata(&requested) {
                    Ok(_) => return Decision::Deny,
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(_) => return Decision::Deny,
                }
                match (requested.parent(), requested.file_name()) {
                    (Some(dir), Some(name)) => match dir.canonicalize() {
                        Ok(d) => d.join(name),
                        Err(_) => return Decision::Deny,
                    },
                    _ => return Decision::Deny,
                }
            }
        };
        let Ok(inside) = resolved.strip_prefix(&root) else {
            return Decision::Deny;
        };
        // re-decide on the resolved relative path: a symlink may have moved
        // the target into a hard-denied or ungranted subtree WITHIN the vault
        self.decide_rel(&inside.to_string_lossy())
    }
}

/// Normalize a vault-relative path for comparison: forward slashes, no empty
/// segments. Refuses (`None`) anything absolute or containing `.`/`..` —
/// those are never legitimate in a vault-relative request, so they are
/// rejected rather than resolved.
fn normalize_rel(rel: &str) -> Option<String> {
    let unified = rel.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for c in Path::new(&unified).components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?),
            Component::CurDir => return None,
            Component::ParentDir => return None,
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(parts.join("/"))
}

/// Does normalized prefix `p` cover normalized path `rel`? Whole-segment
/// containment only — `Notes` covers `Notes/a.md` but never `Notes2/a.md`.
fn covers(p: &str, rel: &str) -> bool {
    p.is_empty() || rel == p || rel.starts_with(&format!("{p}/"))
}

/// Dot-leading segments are denied at EVERY depth, not just at the root.
/// Vault machinery is not all root-level: sealed notes drop a
/// `.substrate-seal` marker inside the folder it protects, and that marker
/// carries the age recipient every note written there gets encrypted to.
/// Readable, it tells a client which folders are secret; writable, a client
/// could point the recipient at a key it holds. No legitimate note path has
/// a dot-leading segment (`a.md` does not — only `.a` does), so denying the
/// whole shape costs nothing and needs no per-artifact allowlist.
fn is_hard_denied(rel: &str) -> bool {
    rel.split('/').any(|seg| seg.starts_with('.'))
        || ROOT_HARD_DENY
            .iter()
            .any(|denied| rel.eq_ignore_ascii_case(denied))
}

/// Can a folder prefix be granted at all? The pane asks before it writes, so
/// the picker refuses on the same shape the engine denies on: a grant whose
/// every path is hard-denied would list as live and resolve to nothing.
///
/// Folder-shaped by nature — the root prefix (`""`) is grantable, and the
/// root-file deny list only ever matches a file — so this is [`is_hard_denied`]
/// asked one question earlier, not a second rule that can drift from it.
pub(crate) fn is_grantable_prefix(prefix: &str) -> bool {
    !is_hard_denied(prefix)
}

/// Case-folded like [`is_hard_denied`]: the vault lives on case-insensitive
/// filesystems, so `agents.md` and `AGENTS.md` are the same file and must
/// reach the same decision.
///
/// ASCII folding only, deliberately: every denied name is ASCII, where the
/// composed and decomposed Unicode spellings a case-insensitive filesystem
/// treats as one file are identical anyway. Adding a non-ASCII name to either
/// deny list must bring NFC normalization with it.
fn is_write_denied(rel: &str) -> bool {
    ROOT_WRITE_DENY.iter().any(|denied| rel.eq_ignore_ascii_case(denied))
}

/// A prefix stored in a grant must already be in normal form — storing
/// anything else would make the file's meaning depend on runtime cleanup.
fn validate_prefix(prefix: &str) -> Result<(), String> {
    match normalize_rel(prefix) {
        Some(n) if n == prefix => Ok(()),
        _ => Err(format!("invalid grant prefix: {prefix:?}")),
    }
}

/// Client names come from MCP initialize and also land in git receipts. Keep
/// the stored identity one-line, bounded, and visibly exact.
pub(crate) fn validate_client(client: &str) -> Result<(), String> {
    if client.trim() != client || client.is_empty() {
        return Err("client name must not be empty or padded".into());
    }
    if client.chars().count() > 80 || client.chars().any(char::is_control) {
        return Err("client name must be one line and at most 80 characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(grants: &[(&str, Access)]) -> ScopeSet {
        ScopeSet {
            grants: grants.iter().map(|(p, a)| Grant::folder("TestClient", p, *a)).collect(),
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn empty_set_denies_everything() {
        let s = ScopeSet::default();
        assert!(s.is_empty());
        assert_eq!(s.decide_rel("Notes/a.md"), Decision::Deny);
        assert_eq!(s.decide_rel(""), Decision::Deny);
    }

    #[test]
    fn grant_covers_subtree_by_whole_segments() {
        let s = set(&[("Notes", Access::Read)]);
        assert_eq!(s.decide_rel("Notes/a.md"), Decision::Allow(Access::Read));
        assert_eq!(s.decide_rel("Notes/deep/b.md"), Decision::Allow(Access::Read));
        assert_eq!(s.decide_rel("Notes"), Decision::Allow(Access::Read));
        // sibling with the prefix as a substring must not match
        assert_eq!(s.decide_rel("Notes2/a.md"), Decision::Deny);
        assert_eq!(s.decide_rel("Finance/a.md"), Decision::Deny);
    }

    #[test]
    fn most_permissive_covering_grant_wins() {
        let s = set(&[("Notes", Access::Read), ("Notes/Inbox", Access::Write)]);
        assert_eq!(s.decide_rel("Notes/a.md"), Decision::Allow(Access::Read));
        assert_eq!(s.decide_rel("Notes/Inbox/c.md"), Decision::Allow(Access::Write));
    }

    #[test]
    fn root_grant_still_excludes_hard_denied_surfaces() {
        let s = set(&[("", Access::Write)]);
        assert_eq!(s.decide_rel("anything.md"), Decision::Allow(Access::Write));
        assert_eq!(s.decide_rel(".vault/folders.json"), Decision::Deny);
        assert_eq!(s.decide_rel(".git/config"), Decision::Deny);
        assert_eq!(s.decide_rel(".future/tool.json"), Decision::Deny);
        assert_eq!(s.decide_rel("Settings.md"), Decision::Deny);
        assert_eq!(s.decide_rel("settings.md"), Decision::Deny);
        // but a note merely NAMED like the config file elsewhere is fine
        assert_eq!(s.decide_rel("Notes/Settings.md"), Decision::Allow(Access::Write));
        assert_eq!(s.decide_rel("Notes/AGENTS.md"), Decision::Allow(Access::Write));
    }

    /// Sealed notes landed after this engine was written: the seal marker
    /// lives INSIDE the folder it protects, so a root-only dot rule would
    /// have left it exposed under any folder grant.
    #[test]
    fn seal_material_is_hard_denied_at_every_depth() {
        let s = set(&[("Notes", Access::Write), ("", Access::Write)]);
        for rel in [
            "Notes/.substrate-seal",
            "Notes/Deep/Nested/.substrate-seal",
            "Notes/.vault/seal-trust.json",
            "Notes/.git/config",
            "Notes/.DS_Store",
        ] {
            assert_eq!(s.decide_rel(rel), Decision::Deny, "{rel}");
            assert!(!s.reveals(rel), "{rel}");
        }
        // and the marker is not merely unwritable — it is unreadable too
        let r = set(&[("Notes", Access::Read)]);
        assert_eq!(r.decide_rel("Notes/.substrate-seal"), Decision::Deny);
        // an ordinary note in the same folder is untouched by the rule
        assert_eq!(s.decide_rel("Notes/a.md"), Decision::Allow(Access::Write));
    }

    #[test]
    fn seal_marker_is_denied_on_the_resolved_path_too() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        fs::create_dir(root.join("Notes")).unwrap();
        fs::write(root.join("Notes/.substrate-seal"), "age1recipient").unwrap();
        let s = set(&[("", Access::Write)]);
        assert_eq!(s.decide_resolved(root, "Notes/.substrate-seal"), Decision::Deny);
        // including a create of one that does not exist yet
        assert_eq!(s.decide_resolved(root, "Notes/.substrate-seal-2"), Decision::Deny);
    }

    #[test]
    fn root_agent_instructions_are_readable_but_never_writable() {
        let s = set(&[("", Access::Write)]);
        // the widest possible grant still cannot author the instructions the
        // next agent reads — case-folded, since the file is the same file
        for rel in ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"] {
            assert_eq!(s.decide_rel(rel), Decision::Allow(Access::Read), "{rel}");
        }
        // a read grant is unchanged by the ceiling, and the same names one
        // folder down are ordinary notes
        let r = set(&[("", Access::Read)]);
        assert_eq!(r.decide_rel("AGENTS.md"), Decision::Allow(Access::Read));
        assert_eq!(s.decide_rel("Notes/CLAUDE.md"), Decision::Allow(Access::Write));
        // and with no covering grant the absence still decides
        assert_eq!(ScopeSet::default().decide_rel("AGENTS.md"), Decision::Deny);
    }

    #[test]
    fn resolved_decision_keeps_the_write_ceiling_on_instruction_files() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        fs::write(root.join("AGENTS.md"), "instructions").unwrap();
        let s = set(&[("", Access::Write)]);
        assert_eq!(s.decide_resolved(root, "AGENTS.md"), Decision::Allow(Access::Read));
        // a not-yet-existing one is capped the same way, so a create cannot
        // author it either
        assert_eq!(s.decide_resolved(root, "CLAUDE.md"), Decision::Allow(Access::Read));
    }

    #[test]
    fn traversal_and_absolute_requests_are_denied_at_string_level() {
        let s = set(&[("", Access::Write)]);
        assert_eq!(s.decide_rel("../outside.md"), Decision::Deny);
        assert_eq!(s.decide_rel("Notes/../../etc/passwd"), Decision::Deny);
        assert_eq!(s.decide_rel("/etc/passwd"), Decision::Deny);
        assert_eq!(s.decide_rel("./Notes/a.md"), Decision::Deny);
    }

    #[test]
    fn backslashes_normalize_to_the_same_decision() {
        let s = set(&[("Notes", Access::Read)]);
        assert_eq!(s.decide_rel("Notes\\a.md"), Decision::Allow(Access::Read));
        assert_eq!(s.decide_rel("..\\outside.md"), Decision::Deny);
    }

    #[test]
    fn load_missing_or_garbage_file_fails_closed() {
        let t = tempfile::tempdir().unwrap();
        assert!(ScopeSet::load(t.path()).is_empty());
        fs::write(t.path().join(SCOPES_FILE), "not json").unwrap();
        assert!(ScopeSet::load(t.path()).is_empty());
    }

    #[test]
    fn a_hand_edited_grant_that_save_would_reject_is_not_honoured() {
        let t = tempfile::tempdir().unwrap();
        // Only a text editor can produce this: an empty client name, which
        // is exactly the name a caller is left with when its own name fails
        // validation. Without the load-time drop the two meet and match.
        fs::write(
            t.path().join(SCOPES_FILE),
            r#"{"grants":[{"client":"","prefix":"Notes","access":"read"},
                          {"client":"GoodName","prefix":"Notes/","access":"read"},
                          {"client":"Real","prefix":"Notes","access":"read"}]}"#,
        )
        .unwrap();
        let loaded = ScopeSet::load(t.path());
        assert_eq!(loaded.grants.len(), 1, "only the valid grant survives: {loaded:?}");
        for caller in ["", "Bad\u{7}Name", " padded ", &"x".repeat(200)] {
            assert_eq!(
                loaded.for_client(caller).decide_rel("Notes/a.md"),
                Decision::Deny,
                "caller {caller:?} matched a grant no editor could have written"
            );
        }
        assert_eq!(loaded.for_client("Real").decide_rel("Notes/a.md"), Decision::Allow(Access::Read));
        // the editor still sees the file as written, so granting cannot
        // quietly delete the rows it refuses to act on
        assert_eq!(ScopeSet::load_for_edit(t.path()).unwrap().grants.len(), 3);
    }

    #[test]
    fn save_load_roundtrip_and_prefix_validation() {
        let t = tempfile::tempdir().unwrap();
        let s = set(&[("Notes", Access::Write), ("", Access::Read)]);
        s.save(t.path()).unwrap();
        assert_eq!(ScopeSet::load(t.path()), s);
        // a prefix that only becomes sane after normalization is refused
        for bad in ["Notes/", "/Notes", "Notes/../Finance", "a\\b"] {
            let s = set(&[(bad, Access::Read)]);
            assert!(s.save(t.path()).is_err(), "prefix {bad:?} must be rejected");
        }
    }

    #[test]
    fn client_filter_is_exact_and_save_preserves_unknown_fields() {
        let t = tempfile::tempdir().unwrap();
        fs::write(
            t.path().join(SCOPES_FILE),
            r#"{
  "future_format": 2,
  "grants": [
    {"client":"Claude","prefix":"Notes","access":"read","transport":"stdio"},
    {"client":"Cursor","prefix":"Projects","access":"write"}
  ]
}"#,
        )
        .unwrap();
        let mut scopes = ScopeSet::load(t.path());
        let claude = scopes.for_client("Claude");
        assert_eq!(claude.grants.len(), 1);
        assert_eq!(claude.grants[0].prefix, "Notes");
        assert!(scopes.for_client("claude").is_empty(), "client matching is exact");
        scopes.grants[0].access = Access::Write;
        scopes.save(t.path()).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(t.path().join(SCOPES_FILE)).unwrap()).unwrap();
        assert_eq!(raw["future_format"], 2);
        assert_eq!(raw["grants"][0]["transport"], "stdio");
    }

    #[test]
    fn resolved_decision_allows_real_files_and_pending_creates() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        fs::create_dir(root.join("Notes")).unwrap();
        fs::write(root.join("Notes/a.md"), "x").unwrap();
        let s = set(&[("Notes", Access::Write)]);
        assert_eq!(s.decide_resolved(root, "Notes/a.md"), Decision::Allow(Access::Write));
        // create: target missing, parent exists
        assert_eq!(s.decide_resolved(root, "Notes/new.md"), Decision::Allow(Access::Write));
        // create into a missing directory is a deny, not a mkdir -p
        assert_eq!(s.decide_resolved(root, "Notes/nodir/new.md"), Decision::Deny);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_out_of_the_vault_is_denied() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("vault");
        let outside = t.path().join("outside");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Notes/link")).unwrap();
        let s = set(&[("Notes", Access::Write)]);
        // the request string sits inside the grant, but the bytes don't
        assert_eq!(s.decide_resolved(&root, "Notes/link/secret.md"), Decision::Deny);
        // and a link whose TARGET is a still-ungranted vault folder is
        // equally closed: resolution re-decides inside the vault too
        fs::create_dir_all(root.join("Finance")).unwrap();
        fs::write(root.join("Finance/f.md"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("Finance"), root.join("Notes/fin")).unwrap();
        assert_eq!(s.decide_resolved(&root, "Notes/fin/f.md"), Decision::Deny);

        // A dangling symlink must not be mistaken for an ordinary missing
        // create target. If its outside target appears later, the grant must
        // not already have blessed the path.
        let missing = outside.join("not-created-yet.md");
        std::os::unix::fs::symlink(&missing, root.join("Notes/dangling.md")).unwrap();
        assert_eq!(s.decide_resolved(&root, "Notes/dangling.md"), Decision::Deny);
    }
}
