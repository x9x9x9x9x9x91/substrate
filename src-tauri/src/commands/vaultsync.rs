//! Vault sync over git: remote setup, push/pull and the parked
//! conflict resolution flow.

use crate::commands::history::with_history;
use crate::gitsync::{self, SyncReport};
use crate::{blocking, AppState, AutoFail, HistoryState, VaultSyncLast, VaultSyncState};
use std::path::Path;
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
    /// The sticky privacy notice, separate from `last_error` because the pane
    /// must keep showing it after the next successful sync — see
    /// [`PrivacyNotice`].
    privacy_error: Option<String>,
    /// The paths whose plaintext that notice is about, so the warning can name
    /// them and a user who wants to purge by hand knows where to look.
    privacy_paths: Vec<String>,
}

/// A failure whose consequence outlives the attempt that hit it.
///
/// `last_error` is one slot, and its Ok arm clears it: with the auto lane
/// pulling every few minutes, anything recorded there is gone within minutes.
/// That is right for a transport miss — the next success genuinely is the
/// news. It is wrong for the one failure whose damage stays behind after the
/// sync succeeds: inherited sealing that could not take its plaintext back out
/// of this vault's own git history. The plaintext is still there, and a user
/// who is never told cannot go and remove it.
///
/// So it gets a slot of its own, on disk beside the sync credentials so a
/// restart does not lose it either. Two things take it away, and no routine
/// sync is either of them: the cleanup finally succeeding (retried under every
/// later pull's locks, see [`retry_privacy_cleanup`]), or the user saying they
/// have seen it (`vault_sync_ack_privacy`).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PrivacyNotice {
    /// What failed, in the words the pane shows.
    pub(crate) message: String,
    /// The paths whose plaintext may still be in local history.
    #[serde(default)]
    pub(crate) paths: Vec<String>,
}

/// Read a notice an earlier run left behind. Anything unreadable or empty is
/// no notice: a corrupt file must not fabricate a privacy warning, and it must
/// not stop the app either.
pub(crate) fn load_privacy(path: &Path) -> Option<PrivacyNotice> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PrivacyNotice>(&raw).ok().filter(|n| !n.message.is_empty())
}

/// Persist (or remove) the notice. A write that fails is logged and dropped:
/// the in-memory slot still tells this session, and a warning the user cannot
/// dismiss because its file is unwritable would be worse than a forgotten one.
fn store_privacy(path: &Path, notice: Option<&PrivacyNotice>) {
    let written = match notice {
        Some(notice) => serde_json::to_string_pretty(notice)
            .map_err(|e| e.to_string())
            .and_then(|json| {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                crate::vault::write_atomic(path, json)
            }),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    };
    if let Err(error) = written {
        applog!("vault sync could not persist its privacy notice: {error}");
    }
}

/// Fold a privacy-class failure into whatever notice is already standing.
/// Returns true when the slot changed and therefore owes a write.
///
/// Folding rather than replacing: a second failure while the first is
/// outstanding describes MORE plaintext, not different plaintext, so the path
/// list is a union and only the message is the newest one's.
fn note_privacy_into(last: &mut VaultSyncLast, message: &str, paths: &[String]) -> bool {
    let mut next = last.privacy.clone().unwrap_or_default();
    next.message = message.to_string();
    for path in paths {
        if !next.paths.contains(path) {
            next.paths.push(path.clone());
        }
    }
    next.paths.sort();
    if last.privacy.as_ref() == Some(&next) {
        return false;
    }
    last.privacy = Some(next);
    true
}

/// What a notice is worth remembering from a failed pull's changed list.
///
/// Only Markdown notes can carry the plaintext this warning is about, so the
/// rest of a checkout — attachments, config, anything else git reports — is
/// dropped at the door, mirroring `reconcile_sealed_changes`' own candidate
/// filter. Seal markers are the one exception and are kept deliberately: a
/// changed marker is what tells the retry's reconcile pass to sweep the whole
/// vault instead of only the paths listed beside it.
fn worth_recording(rel: &str) -> bool {
    is_markdown(rel) || Path::new(rel).file_name().is_some_and(|n| n == crate::vault::SCOPE_MARKER)
}

fn is_markdown(rel: &str) -> bool {
    Path::new(rel).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn record_privacy_failure(state: &State<VaultSyncState>, message: &str, paths: &[String]) {
    let paths: Vec<String> = paths.iter().filter(|p| worth_recording(p)).cloned().collect();
    let mut last = state.last.lock().unwrap();
    if note_privacy_into(&mut last, message, &paths) {
        store_privacy(&state.privacy_path, last.privacy.as_ref());
    }
}

/// Drop the notice. Returns whether there was one, so the caller only pays a
/// disk write when the on-disk copy is actually stale.
fn clear_privacy_into(last: &mut VaultSyncLast) -> bool {
    last.privacy.take().is_some()
}

fn clear_privacy(state: &State<VaultSyncState>) {
    let mut last = state.last.lock().unwrap();
    if clear_privacy_into(&mut last) {
        store_privacy(&state.privacy_path, None);
    }
}

/// The user has read the warning and is done with it. The plaintext may still
/// be in history — this clears the notice, not the history, which is why it is
/// an explicit press and never something a sync does on the user's behalf.
#[tauri::command]
pub(crate) fn vault_sync_ack_privacy(sync: State<VaultSyncState>) {
    clear_privacy(&sync);
}

/// Retry the cleanup an outstanding notice is about, under the caller's pull.
///
/// The failure it records is usually transient — a full disk, a busy lock —
/// and the same purge succeeds on a later tick. Running it here is what lets a
/// resolved notice disappear on its own, so the pane's warning means "plaintext
/// is still in your history" rather than "plaintext was there once".
///
/// Both halves run unconditionally, because either could have been the one
/// that failed: whatever is still plaintext on disk is sealed again, and
/// sealed plaintext is purged from history whether or not this pass converted
/// anything (`purge_files` is idempotent on paths it no longer finds). Which
/// paths that covers — never the whole notice — is
/// [`sealed_plaintext_among`].
fn retry_privacy_cleanup(
    history: &State<HistoryState>,
    state: &State<AppState>,
    sync: &State<VaultSyncState>,
) {
    let outstanding = sync.last.lock().unwrap().privacy.clone();
    let Some(notice) = outstanding else { return };
    if notice.paths.is_empty() {
        // Nothing to retry — this notice can only leave by acknowledgment.
        return;
    }
    let resolved = (|| -> Result<(), String> {
        let hist_guard = history.0.lock().unwrap();
        let hist =
            hist_guard.as_ref().ok_or_else(|| "version history unavailable".to_string())?;
        let mut engine = state.0.lock().unwrap();
        run_privacy_cleanup(hist, &mut engine, &notice.paths)
    })();
    if resolved.is_ok() {
        clear_privacy(sync);
    }
}

/// The retry's two halves, without the locks — seal whatever is still
/// plaintext on disk, then take sealed plaintext out of local history.
fn run_privacy_cleanup(
    hist: &crate::history::History,
    engine: &mut crate::vault::Engine,
    paths: &[String],
) -> Result<(), String> {
    let converted = engine.reconcile_sealed_changes(paths)?;
    let purge = sealed_plaintext_among(engine, paths, converted)?;
    if purge.is_empty() {
        return Ok(());
    }
    let rels: Vec<&str> = purge.iter().map(String::as_str).collect();
    hist.purge_files(&rels)?;
    hist.snapshot("seal plaintext received from sync").ok();
    Ok(())
}

/// Which of a notice's paths this cleanup may take out of history.
///
/// A notice remembers the whole failed pull's changed notes, because at record
/// time nothing had established which of them sealing was about — and
/// `History::purge_files` removes a note under every name it ever had from ALL
/// history and prunes so the content is unrecoverable. Handing it the notice
/// wholesale therefore destroyed the entire version history of every ordinary
/// note that happened to ride the same pull, on a vault where one folder is
/// sealed. So the set is narrowed to plaintext sealing owns:
///
/// - what this pass converted, which is the same set `seal_incoming` purges;
/// - plus notice paths that sit in a confirmed sealed scope now. Those are
///   already ciphertext on disk, so this pass converts nothing for them — but
///   an earlier pass that got as far as the file and died before the purge
///   leaves exactly that: sealed on disk, plaintext still in history.
///
/// Membership is read against the markers standing right now, including for
/// the whole-vault sweep a changed marker triggers. A marker that has since
/// been removed leaves its former notes out of the set, which is the
/// conservative direction: the notice stays standing (nothing cleared it) and
/// the user is still told the plaintext is there, rather than an unconfirmed
/// or withdrawn seal being able to nominate notes for an irreversible purge.
fn sealed_plaintext_among(
    engine: &crate::vault::Engine,
    notice_paths: &[String],
    converted: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut purge = converted;
    for rel in notice_paths.iter().filter(|rel| is_markdown(rel)) {
        if !purge.contains(rel) && engine.note_in_sealed_scope(rel)? {
            purge.push(rel.clone());
        }
    }
    purge.sort();
    purge.dedup();
    Ok(purge)
}

/// Adopt sealed plaintext a sync just checked out, then take it back out of
/// this app-owned git graph. The remote is a separate copy and keeps its own;
/// the caller warns about that.
///
/// Returns the paths it converted — empty when the checkout carried nothing
/// this vault seals.
fn seal_incoming(
    history: &State<HistoryState>,
    state: &State<AppState>,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let hist_guard = history.0.lock().unwrap();
    let hist = hist_guard.as_ref().ok_or_else(|| "version history unavailable".to_string())?;
    let mut engine = state.0.lock().unwrap();
    let converted = engine.reconcile_sealed_changes(paths)?;
    if converted.is_empty() {
        return Ok(converted);
    }
    let rels: Vec<&str> = converted.iter().map(String::as_str).collect();
    hist.purge_files(&rels)?;
    hist.snapshot("seal plaintext received from sync").ok();
    Ok(converted)
}

pub(crate) fn sync_root(state: &State<AppState>) -> std::path::PathBuf {
    state.0.lock().unwrap().root.clone()
}

pub(crate) fn record_sync(state: &State<VaultSyncState>, result: &Result<SyncReport, String>) {
    record_last(&mut state.last.lock().unwrap(), result);
}

/// The last push/pull's outcome, one slot, newest wins. `privacy` is
/// deliberately not part of it: that slot is the record of damage a later
/// success does not undo, and clearing it here is exactly the bug this
/// separation exists to prevent.
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
/// entirely: it records on its first occurrence, on either lane.
///
/// It also leaves the failure run alone, which is conservative rather than
/// exact. The run tracks whether the remote is reachable, and the one Local
/// failure that exists today — sealing after a pull that already fetched and
/// checked out — proves it IS reachable, so ending the run would be the
/// accurate call. Leaving it standing costs at most one more quiet tick: the
/// next successful sync ends the run anyway, and a genuine transport miss
/// would have restarted it. The class stays the general "the remote leg is not
/// what failed", so it is not the place to encode one instance's extra
/// knowledge.
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
    let (privacy_error, privacy_paths) = match &last.privacy {
        Some(notice) => (Some(notice.message.clone()), notice.paths.clone()),
        None => (None, Vec::new()),
    };
    VaultSyncStatus {
        configured,
        last_result: last.result.clone(),
        last_error: last.error.clone(),
        conflicted,
        privacy_error,
        privacy_paths,
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
    // A new remote makes this session's push/pull record meaningless — but not
    // the privacy notice, which is about plaintext in THIS machine's history
    // and is untouched by where the vault syncs to next.
    let mut last = sync.last.lock().unwrap();
    *last = VaultSyncLast { privacy: last.privacy.take(), ..VaultSyncLast::default() };
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
                match seal_incoming(&history, &state, &report.changed) {
                    Ok(converted) => {
                        if !converted.is_empty() {
                            app.emit("vault:seal-remote-plaintext", converted).ok();
                        }
                        // This pass got through, so an earlier one's leftovers
                        // are worth another try — that retry succeeding is
                        // what finally clears the pane's sticky warning.
                        retry_privacy_cleanup(&history, &state, &sync);
                    }
                    Err(error) => {
                        // The checkout already landed. Preserve its path event
                        // so undo/editor state invalidates correctly, but never
                        // report the privacy cleanup as a successful pull.
                        app.emit("vault:pulled", report.changed.clone()).ok();
                        // …and never let the timer lane's quiet window swallow
                        // it either: the remote leg worked, and what failed
                        // left plaintext in this machine's own history.
                        class = FailureClass::Local;
                        let message = format!(
                            "sync landed, but inherited sealing could not remove its plaintext local history: {error}"
                        );
                        // …and never let the NEXT successful tick erase it:
                        // last_error is cleared by any Ok, and the plaintext
                        // this warns about is not.
                        record_privacy_failure(&sync, &message, &report.changed);
                        result = Err(message);
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
            match seal_incoming(&history, &state, &report.changed) {
                Ok(converted) => {
                    if !converted.is_empty() {
                        app.emit("vault:seal-remote-plaintext", converted).ok();
                    }
                    retry_privacy_cleanup(&history, &state, &sync);
                }
                Err(error) => {
                    app.emit("vault:pulled", report.changed.clone()).ok();
                    let message = format!(
                        "sync resolution landed, but inherited sealing could not remove its plaintext local history: {error}"
                    );
                    record_privacy_failure(&sync, &message, &report.changed);
                    result = Err(message);
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
    use super::{
        clear_privacy_into, load_privacy, note_privacy_into, record_outcome_into,
        run_privacy_cleanup, store_privacy, FailureClass,
    };
    use crate::gitsync::SyncReport;
    use crate::history::History;
    use crate::{AutoFail, VaultSyncLast};
    use std::fs;
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

        // The pane's one-slot `error` is still the last attempt's, so the next
        // success takes it back — which is exactly why the same news is also
        // written to the sticky slot the test below covers.
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

    /// Acceptance for the sticky slot: the auto lane pulls every few minutes,
    /// so "recorded" and "still there in five minutes" are different claims.
    /// The plaintext this warns about is in local history until someone
    /// removes it, and no amount of successful syncing removes it.
    #[test]
    fn a_later_successful_sync_does_not_clear_the_privacy_notice() {
        let mut last = VaultSyncLast::default();
        let mut fail = AutoFail::default();
        let t0 = Instant::now();

        note_privacy_into(&mut last, "sealing could not remove its plaintext", &[
            "Sealed/Note.md".to_string()
        ]);
        record_outcome_into(&mut last, &mut fail, &sealing_failed(), true, FailureClass::Local, t0);

        // six ticks of a perfectly healthy vault — half an hour of the exact
        // traffic that used to erase the warning
        for tick in 1..=6 {
            record_outcome_into(
                &mut last,
                &mut fail,
                &ok(),
                true,
                FailureClass::Transport,
                t0 + Duration::from_secs(300 * tick),
            );
        }

        assert!(last.error.is_none(), "the ordinary error slot should have moved on");
        let notice = last.privacy.as_ref().expect("a successful sync erased the privacy notice");
        assert_eq!(notice.message, "sealing could not remove its plaintext");
        assert_eq!(notice.paths, vec!["Sealed/Note.md".to_string()]);
    }

    /// The two things that DO clear it, and the shape of what accumulates
    /// meanwhile: a second failure names a second file without losing the
    /// first, because both files' plaintext is equally still there.
    #[test]
    fn only_a_resolved_cleanup_or_an_acknowledgement_clears_the_privacy_notice() {
        let mut last = VaultSyncLast::default();

        assert!(note_privacy_into(&mut last, "first", &["A.md".to_string()]));
        assert!(note_privacy_into(&mut last, "second", &["B.md".to_string()]));
        assert_eq!(
            last.privacy.as_ref().unwrap().paths,
            vec!["A.md".to_string(), "B.md".to_string()],
            "the second failure dropped the first file's plaintext from the warning"
        );
        assert!(
            !note_privacy_into(&mut last, "second", &["B.md".to_string()]),
            "an unchanged notice asked to be written to disk again"
        );

        // what `vault_sync_ack_privacy` and a resolved retry both call
        assert!(clear_privacy_into(&mut last));
        assert!(last.privacy.is_none());
        assert!(!clear_privacy_into(&mut last), "clearing nothing still wanted a disk write");
    }

    /// A restart is not a way to lose the warning: the slot is in memory, the
    /// plaintext it is about is on disk, so the slot is written beside it.
    #[test]
    fn the_privacy_notice_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!(
            "substrate-privacy-{}-{}",
            std::process::id(),
            line!()
        ));
        let path = dir.join("nested/vault-sync-privacy.json");
        let _ = std::fs::remove_dir_all(&dir);

        let mut last = VaultSyncLast::default();
        note_privacy_into(&mut last, "sealing failed", &["Sealed/Note.md".to_string()]);
        store_privacy(&path, last.privacy.as_ref());

        let reloaded = load_privacy(&path).expect("the notice did not come back after a restart");
        assert_eq!(reloaded, *last.privacy.as_ref().unwrap());

        store_privacy(&path, None);
        assert!(load_privacy(&path).is_none(), "an acknowledged notice came back anyway");

        let _ = std::fs::remove_dir_all(&dir);
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

    /// A notice remembers the whole failed pull, sealed and ordinary notes
    /// together — so the retry that finally succeeds must take only sealing's
    /// plaintext out of history. Purging the notice wholesale destroyed every
    /// version of every ordinary note that happened to arrive in the same
    /// pull, silently, on the tick that made the warning go away.
    #[test]
    fn a_privacy_retry_purges_sealed_plaintext_and_leaves_the_rest_of_the_pull_alone() {
        let (mut engine, root) = crate::vault::testutil::temp_vault("sync-privacy-retry");
        engine.create_folder("Private").unwrap();
        let ordinary =
            engine.create_full("Diary", "Inbox", None, None, Some("ordinary needle")).unwrap();
        let secret =
            engine.create_full("Secret", "Private", None, None, Some("sealed needle")).unwrap();

        let hist = History::new(root.clone()).unwrap();
        hist.snapshot("first").unwrap();
        fs::write(root.join(&ordinary.path), "ordinary needle, edited\n").unwrap();
        hist.snapshot("second").unwrap();
        assert_eq!(hist.list(&ordinary.path).unwrap().len(), 2, "fixture needs two versions");

        // Sealing arrives after the plaintext is already in history — the
        // inherited-sealing case the notice exists for. The file on disk is
        // ciphertext now, so the retry converts nothing and the purge set
        // rests entirely on where the path sits.
        engine.prepare_seal_scope("Private", Some("correct horse")).unwrap();
        engine.finish_seal_scope().unwrap();
        assert!(hist.list(&secret.path).unwrap().len() >= 1, "fixture needs sealed history");

        let notice = vec![ordinary.path.clone(), secret.path.clone()];
        run_privacy_cleanup(&hist, &mut engine, &notice).unwrap();

        assert_eq!(
            hist.list(&ordinary.path).unwrap().len(),
            2,
            "the retry destroyed an ordinary note's version history"
        );
        let log = std::process::Command::new("git")
            .args(["-C", &root.to_string_lossy(), "log", "--all", "-p"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap();
        assert!(log.contains("ordinary needle"), "the ordinary note's content is unrecoverable");
        assert!(!log.contains("sealed needle"), "sealed plaintext survived the purge");

        let _ = fs::remove_dir_all(&root);
    }
}
