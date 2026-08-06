//! Settings-owned MCP grants — the pane's write path.
//!
//! Grants are machine config, never vault content. This command layer is the
//! only UI writer of `mcp-scopes.json`: it converts a native folder pick into
//! a canonical vault-relative prefix, keeps unknown JSON fields, and returns
//! a deliberately small DTO so future transport metadata does not become UI.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::mcpdoor::lastseen::{self, LastSeen};
use crate::mcpdoor::scope::{is_grantable_prefix, validate_client, Access, Grant, ScopeSet};
use crate::{AppState, OnboardingState};

#[derive(Clone, Serialize)]
pub(crate) struct McpGrantView {
    client: String,
    prefix: String,
    access: Access,
}

impl From<&Grant> for McpGrantView {
    fn from(grant: &Grant) -> Self {
        Self { client: grant.client.clone(), prefix: grant.prefix.clone(), access: grant.access }
    }
}

#[derive(Serialize)]
pub(crate) struct McpSetup {
    binary_path: String,
    binary_available: bool,
    client_config_path: String,
    claude_desktop_snippet: String,
}

fn views(scopes: &ScopeSet) -> Vec<McpGrantView> {
    scopes.grants.iter().map(McpGrantView::from).collect()
}

/// Read the current per-machine grants. A corrupt file is surfaced here
/// instead of being rewritten; the sidecar itself still fails closed.
#[tauri::command]
pub(crate) fn mcp_grants_list(
    onboarding: State<OnboardingState>,
) -> Result<Vec<McpGrantView>, String> {
    ScopeSet::load_for_edit(&onboarding.config_dir).map(|s| views(&s))
}

/// Native folder picker + grant write in one command. Keeping the picker here
/// means the webview never decides whether an arbitrary absolute path belongs
/// to the vault; the canonical filesystem does.
#[tauri::command]
pub(crate) async fn mcp_grant_pick(
    app: tauri::AppHandle,
    onboarding: State<'_, OnboardingState>,
    state: State<'_, AppState>,
    client: String,
    access: Access,
) -> Result<Vec<McpGrantView>, String> {
    #[cfg(mobile)]
    {
        let _ = (app, onboarding, state, client, access);
        return Err("MCP folder grants are available on desktop only".into());
    }
    // The picker blocks until the user answers, which can be minutes. Run it on
    // a blocking thread so a `Grant folder…` dialog left open doesn't sit on an
    // async worker the rest of the app's commands are queued behind.
    #[cfg(desktop)]
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("the folder picker didn't come back: {e}"))?;

    #[cfg(desktop)]
    let Some(picked) = picked
    else {
        // Cancellation is a no-op, not a toast-worthy error.
        return mcp_grants_list(onboarding);
    };
    #[cfg(desktop)]
    let folder = picked.into_path().map_err(|_| "the chosen folder has no filesystem path")?;
    #[cfg(desktop)]
    let root = state.0.lock().unwrap().root.clone();
    #[cfg(desktop)]
    add_grant(&onboarding.config_dir, &root, &folder, &client, access).map(|s| views(&s))
}

#[tauri::command]
pub(crate) fn mcp_grant_revoke(
    onboarding: State<OnboardingState>,
    client: String,
    prefix: String,
) -> Result<Vec<McpGrantView>, String> {
    let mut scopes = ScopeSet::load_for_edit(&onboarding.config_dir)?;
    scopes.grants.retain(|g| !(g.client == client && g.prefix == prefix));
    scopes.save(&onboarding.config_dir)?;
    Ok(views(&scopes))
}

#[tauri::command]
pub(crate) fn mcp_grants_revoke_all(
    onboarding: State<OnboardingState>,
) -> Result<Vec<McpGrantView>, String> {
    let mut scopes = ScopeSet::load_for_edit(&onboarding.config_dir)?;
    scopes.grants.clear();
    scopes.save(&onboarding.config_dir)?;
    Ok(Vec::new())
}

/// The name the door last saw at `initialize`, for the pane's diagnostic line.
/// Never an error: a missing or unreadable breadcrumb just means "nothing seen".
#[tauri::command]
pub(crate) fn mcp_last_seen(onboarding: State<OnboardingState>) -> Option<LastSeen> {
    lastseen::load(&onboarding.config_dir)
}

#[tauri::command]
pub(crate) fn mcp_setup() -> Result<McpSetup, String> {
    #[cfg(mobile)]
    {
        return Err("MCP is available on desktop only".into());
    }
    #[cfg(desktop)]
    {
        let binary = sidecar_path()?;
        let config = claude_desktop_config_path()?;
        let snippet = serde_json::to_string_pretty(&serde_json::json!({
            "mcpServers": {
                "substrate": {
                    "command": binary.display().to_string()
                }
            }
        }))
        .map_err(|e| e.to_string())?;
        Ok(McpSetup {
            binary_path: binary.display().to_string(),
            binary_available: binary.is_file(),
            client_config_path: config.display().to_string(),
            claude_desktop_snippet: snippet,
        })
    }
}

fn add_grant(
    cfg_dir: &Path,
    vault_root: &Path,
    folder: &Path,
    client: &str,
    access: Access,
) -> Result<ScopeSet, String> {
    validate_client(client)?;
    let root =
        vault_root.canonicalize().map_err(|e| format!("couldn't resolve the open vault: {e}"))?;
    let picked =
        folder.canonicalize().map_err(|e| format!("couldn't resolve the chosen folder: {e}"))?;
    if !picked.is_dir() {
        return Err("choose a folder, not a file".into());
    }
    let rel =
        picked.strip_prefix(&root).map_err(|_| "choose the vault itself or a folder inside it")?;
    let prefix = relative_prefix(rel)?;
    // Reject on the shape the engine denies on, not on one named folder: a
    // leading dot at any depth is hard-denied for every path under it, so a
    // grant stored here would list as live and never resolve.
    if !is_grantable_prefix(&prefix) {
        return Err("folders whose name starts with a dot can never be shared".into());
    }

    let mut scopes = ScopeSet::load_for_edit(cfg_dir)?;
    if let Some(existing) =
        scopes.grants.iter_mut().find(|g| g.client == client && g.prefix == prefix)
    {
        existing.access = access;
    } else {
        scopes.grants.push(Grant {
            client: client.to_string(),
            prefix,
            access,
            extra: Default::default(),
        });
    }
    scopes.grants.sort_by(|a, b| (&a.client, &a.prefix).cmp(&(&b.client, &b.prefix)));
    scopes.save(cfg_dir)?;
    Ok(scopes)
}

fn relative_prefix(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(
                part.to_str().ok_or("the chosen folder name is not valid Unicode")?.to_string(),
            ),
            _ => return Err("the chosen folder is not a normal vault path".into()),
        }
    }
    Ok(parts.join("/"))
}

/// Packaged app and `tauri dev` both put the sidecar beside the main binary.
/// `beforeBundleCommand` guarantees the packaged sibling exists.
fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("couldn't locate Substrate: {e}"))?;
    let dir = exe.parent().ok_or("couldn't locate Substrate's binary folder")?;
    #[cfg(target_os = "windows")]
    let name = "substrate-mcp.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "substrate-mcp";
    Ok(dir.join(name))
}

fn claude_desktop_config_path() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME")
            .map(|h| {
                PathBuf::from(h)
                    .join("Library/Application Support/Claude/claude_desktop_config.json")
            })
            .ok_or_else(|| "couldn't locate the home folder".into());
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(|d| PathBuf::from(d).join("Claude/claude_desktop_config.json"))
            .ok_or_else(|| "couldn't locate the app-data folder".into());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .ok_or("couldn't locate the config folder")?;
        Ok(base.join("Claude/claude_desktop_config.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn add_rejects_outside_and_private_folders_then_upserts_exact_grant() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("vault");
        let cfg = t.path().join("cfg");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::create_dir_all(root.join(".vault")).unwrap();
        fs::create_dir_all(t.path().join("outside")).unwrap();

        assert!(add_grant(&cfg, &root, &t.path().join("outside"), "Claude", Access::Read).is_err());
        assert!(add_grant(&cfg, &root, &root.join(".vault"), "Claude", Access::Read).is_err());

        // Dot-folders are denied at every depth by the engine, so the picker
        // has to refuse a nested one too — accepting it would store a grant
        // that shows as live in the pane and denies every call.
        fs::create_dir_all(root.join("Notes/.secret/deeper")).unwrap();
        for inert in [root.join("Notes/.secret"), root.join("Notes/.secret/deeper")] {
            assert!(
                add_grant(&cfg, &root, &inert, "Claude", Access::Read).is_err(),
                "{inert:?} resolves to nothing and must not be grantable"
            );
        }

        let first = add_grant(&cfg, &root, &root.join("Notes"), "Claude", Access::Read).unwrap();
        assert_eq!(first.grants.len(), 1);
        assert_eq!(first.grants[0].prefix, "Notes");
        let updated = add_grant(&cfg, &root, &root.join("Notes"), "Claude", Access::Write).unwrap();
        assert_eq!(updated.grants.len(), 1, "same client+folder is an upsert");
        assert_eq!(updated.grants[0].access, Access::Write);
    }

    #[test]
    fn root_folder_becomes_the_empty_prefix() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("vault");
        fs::create_dir_all(&root).unwrap();
        let scopes =
            add_grant(&t.path().join("cfg"), &root, &root, "Claude", Access::Read).unwrap();
        assert_eq!(scopes.grants[0].prefix, "");
    }
}
