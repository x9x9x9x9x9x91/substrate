//! Vault sync over git (SUB-516/572): remote setup, push/pull and the parked
//! conflict resolution flow.

use crate::commands::history::with_history;
use crate::gitsync::{self, SyncReport};
use crate::{blocking, AppState, HistoryState, VaultSyncLast, VaultSyncState};
use tauri::{Emitter, Manager, State};

#[derive(serde::Serialize)]
pub(crate) struct VaultSyncStatus {
    configured: bool,
    last_result: Option<SyncReport>,
    last_error: Option<String>,
    /// Paths of the conflicted merge parked in git, read from the repository
    /// rather than from this session's last result (SUB-572). `last_result`
    /// is empty after a restart, so a pane deriving "needs attention" from it
    /// alone reported Ready while a conflicted merge was still waiting.
    conflicted: Vec<String>,
}

pub(crate) fn sync_root(state: &State<AppState>) -> std::path::PathBuf {
    state.0.lock().unwrap().root.clone()
}

pub(crate) fn record_sync(state: &State<VaultSyncState>, result: &Result<SyncReport, String>) {
    let mut last = state.last.lock().unwrap();
    match result {
        Ok(report) => {
            last.result = Some(report.clone());
            last.error = None;
        }
        Err(error) => {
            last.result = None;
            last.error = Some(error.clone());
        }
    }
}

#[tauri::command]
pub(crate) fn vault_sync_status(
    state: State<AppState>,
    sync: State<VaultSyncState>,
) -> VaultSyncStatus {
    let root = sync_root(&state);
    let configured = gitsync::sync_configured(&root);
    let conflicted = if configured { gitsync::sync_pending_conflicts(&root) } else { Vec::new() };
    let last = sync.last.lock().unwrap();
    VaultSyncStatus {
        configured,
        last_result: last.result.clone(),
        last_error: last.error.clone(),
        conflicted,
    }
}

#[tauri::command]
pub(crate) fn vault_sync_set_remote(
    state: State<AppState>,
    sync: State<VaultSyncState>,
    url: String,
    token: String,
    cert: Option<String>,
) -> Result<(), String> {
    gitsync::sync_set_remote(
        &sync_root(&state),
        &sync.credentials_path,
        &url,
        &token,
        cert.as_deref(),
    )?;
    *sync.last.lock().unwrap() = VaultSyncLast::default();
    Ok(())
}

// async: a push is a snapshot plus network git — seconds on a slow link.
#[tauri::command]
pub(crate) async fn vault_sync_push(app: tauri::AppHandle) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        with_history(&history, |hist| hist.snapshot("snapshot (sync)"))?;
        // Gate: the engine mutex is held only while the working tree is
        // inspected, never across the network push.
        let result = gitsync::sync_push_gated(&sync_root(&state), &sync.credentials_path, || {
            state.0.lock().unwrap()
        });
        record_sync(&sync, &result);
        result
    })
    .await?
}

// async for the same reason as push (network git off the IPC thread).
#[tauri::command]
pub(crate) async fn vault_sync_pull(app: tauri::AppHandle) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // Protect edits made since the last idle snapshot before replacing files.
        with_history(&history, |hist| hist.snapshot("snapshot (sync)"))?;
        // Gate: history first, then engine (the repo-wide lock order), held
        // through the whole local phase. The fetch stays unlocked, but neither
        // an auto-snapshot nor a vault write can land between the final HEAD /
        // clean checks and checkout + branch update (SUB-731).
        let mut result = gitsync::sync_pull_gated(&sync_root(&state), &sync.credentials_path, || {
            let history = history.0.lock().unwrap();
            let engine = state.0.lock().unwrap();
            (history, engine)
        });
        if let Ok(report) = &result {
            if !report.changed.is_empty() {
                // The remote commit may come from an old/non-cooperating
                // writer that ignored a persistent marker. Adopt its working
                // files with the public recipient, then remove those paths
                // from THIS app-owned Git graph. The remote is a separate copy
                // and gets an explicit UI warning below.
                let cleanup: Result<Vec<String>, String> = (|| {
                    let hist_guard = history.0.lock().unwrap();
                    let hist = hist_guard
                        .as_ref()
                        .ok_or_else(|| "version history unavailable".to_string())?;
                    let mut engine = state.0.lock().unwrap();
                    let converted = engine.reconcile_sealed_changes(&report.changed)?;
                    if converted.is_empty() {
                        return Ok(converted);
                    }
                    let rels: Vec<&str> = converted.iter().map(String::as_str).collect();
                    hist.purge_files(&rels)?;
                    hist.snapshot("seal plaintext received from sync").ok();
                    Ok(converted)
                })();
                match cleanup {
                    Ok(converted) if !converted.is_empty() => {
                        app.emit("vault:seal-remote-plaintext", converted).ok();
                    }
                    Ok(_) => {}
                    Err(error) => {
                        // The checkout already landed. Preserve its path event
                        // so undo/editor state invalidates correctly, but never
                        // report the privacy cleanup as a successful pull.
                        app.emit("vault:pulled", report.changed.clone()).ok();
                        result = Err(format!(
                            "sync landed, but inherited sealing could not remove its plaintext local history: {error}"
                        ));
                    }
                }
            }
        }
        record_sync(&sync, &result);
        announce_pull(&app, &result);
        result
    })
    .await?
}

/// Tell the app which paths a pull just rewrote (SUB-516, docs/undo.md §3.5).
/// A checkout is not undoable, so the undo stack has to drop exactly the
/// entries it stepped on — and learning that from the OS watcher instead would
/// arrive a debounce later, with the paths already blurred into whatever else
/// changed in the same window. Emitted only when a checkout really landed;
/// an up-to-date pull or a parked conflict changed no files and says nothing.
pub(crate) fn announce_pull(app: &tauri::AppHandle, result: &Result<SyncReport, String>) {
    if let Ok(report) = result {
        if !report.changed.is_empty() {
            app.emit("vault:pulled", report.changed.clone()).ok();
        }
    }
}

/// The parked conflicted pull, rebuilt from git on every call — there is no
/// in-process resolution session to lose.
#[tauri::command]
pub(crate) fn vault_sync_conflicts(
    state: State<AppState>,
) -> Result<gitsync::ConflictState, String> {
    gitsync::sync_conflicts(&sync_root(&state))
}

#[tauri::command]
pub(crate) fn vault_sync_resolve_set(
    state: State<AppState>,
    path: String,
    choice: String,
) -> Result<gitsync::ConflictState, String> {
    gitsync::sync_resolve_set(&sync_root(&state), &path, &choice)
}

#[tauri::command]
pub(crate) fn vault_sync_resolve_clear(
    state: State<AppState>,
    path: String,
) -> Result<gitsync::ConflictState, String> {
    gitsync::sync_resolve_clear(&sync_root(&state), &path)
}

#[tauri::command]
pub(crate) fn vault_sync_resolve_finish(
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    sync: State<VaultSyncState>,
) -> Result<SyncReport, String> {
    // Same guard as a pull: protect edits made since the last idle snapshot
    // before the resolved merge is checked out.
    with_history(&history, |hist| hist.snapshot("snapshot (sync)"))?;
    // Gate: history first, then engine, held for the whole local phase so an
    // auto-snapshot cannot move HEAD after its final check and a vault write
    // cannot land before the forced checkout. `sync_root` deliberately takes
    // and releases the engine lock before this — read the root, then acquire
    // both gates in repo-wide order.
    let root = sync_root(&state);
    let mut result = gitsync::sync_resolve_finish_gated(&root, || {
        let history = history.0.lock().unwrap();
        let engine = state.0.lock().unwrap();
        (history, engine)
    });
    if let Ok(report) = &result {
        if !report.changed.is_empty() {
            let cleanup: Result<Vec<String>, String> = (|| {
                let hist_guard = history.0.lock().unwrap();
                let hist =
                    hist_guard.as_ref().ok_or_else(|| "version history unavailable".to_string())?;
                let mut engine = state.0.lock().unwrap();
                let converted = engine.reconcile_sealed_changes(&report.changed)?;
                if converted.is_empty() {
                    return Ok(converted);
                }
                let rels: Vec<&str> = converted.iter().map(String::as_str).collect();
                hist.purge_files(&rels)?;
                hist.snapshot("seal plaintext received from sync").ok();
                Ok(converted)
            })();
            match cleanup {
                Ok(converted) if !converted.is_empty() => {
                    app.emit("vault:seal-remote-plaintext", converted).ok();
                }
                Ok(_) => {}
                Err(error) => {
                    app.emit("vault:pulled", report.changed.clone()).ok();
                    result = Err(format!(
                        "sync resolution landed, but inherited sealing could not remove its plaintext local history: {error}"
                    ));
                }
            }
        }
    }
    record_sync(&sync, &result);
    // Finishing a resolution checks a merge out exactly like a pull does.
    announce_pull(&app, &result);
    result
}
