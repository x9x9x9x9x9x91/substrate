//! The feed dashboard's refresh dispatch:
//! thin wrappers over curator.rs, which supervises the user's configured
//! `feed-curator` command. Policy — which command runs, and the per-machine
//! trust approval for it — lives in the frontend; these commands are
//! mechanism only.

use tauri::State;

use crate::curator;

/// Run the configured curator command, cwd'd at the vault root; refused
/// while one is live. Completion is polled via curator_runs (the result
/// lands through the vault watcher).
#[tauri::command]
pub(crate) fn curator_refresh(
    command: String,
    vault: State<crate::AppState>,
) -> Result<curator::CuratorRun, String> {
    let vault_root = vault.0.lock().unwrap().root.clone();
    curator::refresh(&command, &vault_root)
}

/// The running + recently finished curation runs the UI polls.
#[tauri::command]
pub(crate) fn curator_runs() -> Vec<curator::CuratorRun> {
    curator::runs()
}

/// Kill the live curation run.
#[tauri::command]
pub(crate) fn curator_cancel(id: String) -> Result<(), String> {
    curator::cancel(&id)
}
