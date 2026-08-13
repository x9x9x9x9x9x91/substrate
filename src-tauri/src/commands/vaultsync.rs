//! Vault sync over git: remote setup, push/pull and the parked
//! conflict resolution flow.

use crate::commands::history::with_history;
use crate::gitsync::{self, SyncReport};
use crate::{blocking, AppState, AutoFail, HistoryState, VaultSyncLast, VaultSyncState};
use std::time::Instant;
use tauri::{Emitter, Manager, State};

#[derive(serde::Serialize)]
pub(crate) struct VaultSyncStatus {
    configured: bool,
    last_result: Option<SyncReport>,
    last_error: Option<String>,
    /// Paths of the conflicted merge parked in git, read from the repository
    /// rather than from this session's last result. `last_result`
    /// is empty after a restart, so a pane deriving "needs attention" from it
    /// alone reported Ready while a conflicted merge was still waiting.
    conflicted: Vec<String>,
}

pub(crate) fn sync_root(state: &State<AppState>) -> std::path::PathBuf {
    state.0.lock().unwrap().root.clone()
}

pub(crate) fn record_sync(state: &State<VaultSyncState>, result: &Result<SyncReport, String>) {
    record_last(&mut state.last.lock().unwrap(), result);
}

fn record_last(last: &mut VaultSyncLast, result: &Result<SyncReport, String>) {
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

/// Where a failed attempt came from, which decides whether the auto lane may
/// keep quiet about it.
///
/// The quiet window is for a device that cannot reach its remote, and for
/// nothing else. A failure whose consequence is LOCAL has to reach the pane on
/// the spot: the one that exists today is inherited sealing failing to remove
/// its plaintext from this vault's own history, and silence there means the
/// user is never told that sealed content is sitting in their local history —
/// permanently, because the next successful tick clears the failure run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FailureClass {
    /// Could not reach or exchange with the remote.
    Transport,
    /// The remote leg worked; something on this machine did not.
    Local,
}

/// The recording rule that separates the timer lane from the button. A manual
/// attempt always lands in the pane's last record, failure included. An auto
/// attempt records its successes — but a transport failure stays quiet until
/// the lane has been failing continuously for hours, so an offline device
/// never repaints the pane "Error" over a nap.
pub(crate) fn record_outcome(
    state: &State<VaultSyncState>,
    result: &Result<SyncReport, String>,
    auto: bool,
    class: FailureClass,
) {
    let mut last = state.last.lock().unwrap();
    let mut fail = state.auto_fail.lock().unwrap();
    record_outcome_into(&mut last, &mut fail, result, auto, class, Instant::now());
}

/// [`record_outcome`] over plain state, so the rule is testable without an app.
///
/// A [`FailureClass::Local`] failure is outside the quiet window's bargain
/// entirely: it records on its first occurrence, on either lane. It also
/// leaves the failure run alone in both directions — the run tracks whether
/// the remote is reachable, and an attempt that got far enough to fail locally
/// answered that question neither way.
pub(crate) fn record_outcome_into(
    last: &mut VaultSyncLast,
    fail: &mut AutoFail,
    result: &Result<SyncReport, String>,
    auto: bool,
    class: FailureClass,
    now: Instant,
) {
    let record = match result {
        Ok(_) => {
            fail.note_success();
            true
        }
        Err(_) if !auto || class == FailureClass::Local => true,
        Err(_) => fail.note_failure(now),
    };
    if record {
        record_last(last, result);
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
// `origin: Some("auto")` marks a timer-driven attempt (quiet failure rule,
// see record_outcome); the button passes nothing.
#[tauri::command]
pub(crate) async fn vault_sync_push(
    app: tauri::AppHandle,
    origin: Option<String>,
) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // One network leg at a time — before the history gate, so lock order
        // stays op → history → engine in every sync command. Poison-tolerant:
        // it guards no data, and one panicked sync must not brick every later
        // one for the life of the process.
        let _op = sync.op.lock().unwrap_or_else(|e| e.into_inner());
        with_history(&history, |hist| hist.snapshot("snapshot (sync)"))?;
        // Gate: the engine mutex is held only while the working tree is
        // inspected, never across the network push.
        let result = gitsync::sync_push_gated(&sync_root(&state), &sync.credentials_path, || {
            state.0.lock().unwrap()
        });
        record_outcome(&sync, &result, origin.as_deref() == Some("auto"), FailureClass::Transport);
        result
    })
    .await?
}

// async for the same reason as push (network git off the IPC thread).
// `origin: Some("auto")` marks a timer-driven attempt, same as push.
#[tauri::command]
pub(crate) async fn vault_sync_pull(
    app: tauri::AppHandle,
    origin: Option<String>,
) -> Result<SyncReport, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let history: State<HistoryState> = app.state();
        let sync: State<VaultSyncState> = app.state();
        // Same one-network-leg gate as push, taken first for lock order, and
        // poison-tolerant for the same reason.
        let _op = sync.op.lock().unwrap_or_else(|e| e.into_inner());
        // Fetch, then protect edits made since the last idle snapshot — but
        // only when the fetch brought something a checkout would overwrite.
        // Gate: history first, then engine (the repo-wide lock order), held
        // through the whole local phase. The fetch stays unlocked, but neither
        // an auto-snapshot nor a vault write can land between the final HEAD /
        // clean checks and checkout + branch update.
        let mut class = FailureClass::Transport;
        let mut result = gitsync::sync_pull_with_snapshot(
            &sync_root(&state),
            &sync.credentials_path,
            || with_history(&history, |hist| hist.snapshot("snapshot (sync)")).map(|_| ()),
            || {
                let history = history.0.lock().unwrap();
                let engine = state.0.lock().unwrap();
                (history, engine)
            },
        );
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
                        // …and never let the timer lane's quiet window swallow
                        // it either: the remote leg worked, and what failed
                        // left plaintext in this machine's own history.
                        class = FailureClass::Local;
                        result = Err(format!(
                            "sync landed, but inherited sealing could not remove its plaintext local history: {error}"
                        ));
                    }
                }
            }
        }
        record_outcome(&sync, &result, origin.as_deref() == Some("auto"), class);
        announce_pull(&app, &result);
        result
    })
    .await?
}

/// Tell the app which paths a pull just rewrote (docs/undo.md §3.5).
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

#[cfg(test)]
mod tests {
    use super::{record_outcome_into, FailureClass};
    use crate::gitsync::SyncReport;
    use crate::{AutoFail, VaultSyncLast};
    use std::time::{Duration, Instant};

    fn ok() -> Result<SyncReport, String> {
        Ok(SyncReport {
            pushed: 0,
            pulled: 1,
            conflicted: Vec::new(),
            head: "0".repeat(40),
            changed: vec!["Note.md".to_string()],
        })
    }

    fn sealing_failed() -> Result<SyncReport, String> {
        Err("sync landed, but inherited sealing could not remove its plaintext local history: \
             disk full"
            .to_string())
    }

    /// The privacy-class failure the quiet window must never cover. It is
    /// local, not transport: the pull reached the remote and checked its
    /// commit out, and what failed left sealed plaintext in this machine's own
    /// history. A user who is never told cannot go and remove it — and under
    /// the transport rule the next successful tick would clear the run and the
    /// record with it, so the news would be gone for good.
    #[test]
    fn an_auto_pulls_sealing_cleanup_failure_records_at_once() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();

        record_outcome_into(&mut last, &mut fail, &sealing_failed(), true, FailureClass::Local, t0);
        assert_eq!(
            last.error.as_deref(),
            Some(
                "sync landed, but inherited sealing could not remove its plaintext local \
                 history: disk full"
            ),
            "the auto lane kept a local privacy failure to itself"
        );
        assert!(last.result.is_none());

        // …and it stays told: a later success is the only thing that clears it
        record_outcome_into(
            &mut last,
            &mut fail,
            &ok(),
            true,
            FailureClass::Transport,
            t0 + Duration::from_secs(300),
        );
        assert!(last.error.is_none());
    }

    /// The other half of the same rule, unchanged: a transport miss on the
    /// auto lane stays quiet until the run is hours old, and a manual attempt
    /// never waits at all.
    #[test]
    fn an_auto_transport_failure_still_waits_out_the_quiet_window() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();
        let offline: Result<SyncReport, String> = Err("vault sync fetch failed: no route".into());

        record_outcome_into(&mut last, &mut fail, &offline, true, FailureClass::Transport, t0);
        assert!(last.error.is_none(), "one offline tick repainted the pane");

        record_outcome_into(
            &mut last,
            &mut fail,
            &offline,
            true,
            FailureClass::Transport,
            t0 + crate::AUTO_SYNC_FAIL_SURFACE_AFTER,
        );
        assert!(last.error.is_some(), "hours of failure stayed quiet");

        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        record_outcome_into(&mut last, &mut fail, &offline, false, FailureClass::Transport, t0);
        assert!(last.error.is_some(), "a button press hid its own failure");
    }
}
