//! Deep Recall: search the vault's whole past, not just its present.
//!
//! Four commands and a switch. The switch is per vault and per DEVICE
//! (`appcfg::AppConfig::recall`, keyed by canonical vault path — the same
//! reasoning as reflexes consent and custom kinds: the index is a device-local
//! SQLite file, so the decision to build one belongs to the device that pays
//! for it, and a marker inside the vault would sync the decision everywhere).
//!
//! Indexing is the only slow part. It runs on the blocking pool and reports
//! progress on `recall:index`, because the first pass over a years-old vault
//! is minutes of git walking and a spinner would be a lie about how long.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::vault::{Recall, RecallResult, RecallStats};
use crate::{blocking, AppState, OnboardingState};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// One index run at a time. A second click while the first walk is going
/// would fight it for the same SQLite write lock and index nothing new.
static INDEXING: AtomicBool = AtomicBool::new(false);

/// Progress on `recall:index`: snapshots walked out of snapshots to walk.
/// `total` is 0 when there was nothing new, which the frontend reads as done.
#[derive(Clone, Serialize)]
struct IndexProgress {
    done: u32,
    total: u32,
}

/// What the Settings row shows: whether the switch is on, whether an index
/// exists, and how much history and disk it accounts for.
#[derive(Serialize)]
pub(crate) struct RecallStatus {
    pub enabled: bool,
    /// True while an index run is walking.
    pub indexing: bool,
    #[serde(flatten)]
    pub stats: RecallStats,
}

fn recall_for(state: &State<AppState>, onboarding: &State<OnboardingState>) -> Recall {
    let root = state.0.lock().unwrap().root.clone();
    Recall::new(root, &onboarding.config_dir)
}

#[tauri::command]
pub(crate) fn recall_status(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
) -> RecallStatus {
    let root = state.0.lock().unwrap().root.clone();
    let enabled = crate::appcfg::recall_enabled(&onboarding.config_dir, &root);
    RecallStatus {
        enabled,
        indexing: INDEXING.load(Ordering::Relaxed),
        // Reading the row must not build anything: with the switch off there
        // is nothing to report, and asking would otherwise be enough to create
        // the store file the switch says should not exist.
        stats: if enabled {
            recall_for(&state, &onboarding).stats()
        } else {
            RecallStats::default()
        },
    }
}

/// Drop the historical index after a history rewrite. Purge, seal and trim
/// replay every commit, so the rows here describe writing that was
/// deliberately destroyed; the read paths notice that on their own, and this
/// is the belt to those braces — the second copy stops existing when the
/// rewrite lands rather than when somebody next searches. Best effort by
/// design: a rewrite that already succeeded must not be reported as failed
/// because a derived index would not delete.
///
/// Takes the vault root rather than reading it off the shared state, so the
/// seal paths — which call this while they still hold the engine lock — can
/// use it without waiting on a lock they are already holding.
pub(crate) fn clear_after_rewrite(config_dir: &std::path::Path, root: &std::path::Path) {
    if crate::appcfg::recall_enabled(config_dir, root) {
        let _ = Recall::new(root.to_path_buf(), config_dir).clear();
    }
}

/// Turn Deep Recall on or off for this vault on this device. Turning it OFF
/// deletes the store rather than parking it: the index is a second copy of
/// deleted writing, and a user switching the feature off is asking for that
/// copy to stop existing, not to sit there unused.
#[tauri::command]
pub(crate) fn recall_set_enabled(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    enabled: bool,
) -> Result<RecallStatus, String> {
    let root = state.0.lock().unwrap().root.clone();
    crate::appcfg::write_recall_enabled(&onboarding.config_dir, &root, enabled)?;
    if !enabled {
        recall_for(&state, &onboarding).clear()?;
    }
    Ok(recall_status(state, onboarding))
}

/// Walk whatever history is not indexed yet. Cheap and near-instant on the
/// second run; the first one over a long history is the slow case the
/// progress events exist for.
#[tauri::command]
pub(crate) async fn recall_index(app: tauri::AppHandle) -> Result<RecallStats, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let onboarding: State<OnboardingState> = app.state();
        let root = state.0.lock().unwrap().root.clone();
        if !crate::appcfg::recall_enabled(&onboarding.config_dir, &root) {
            return Err("Deep Recall is off for this vault".into());
        }
        if INDEXING.swap(true, Ordering::SeqCst) {
            return Err("already indexing".into());
        }
        let recall = Recall::new(root, &onboarding.config_dir);
        let mut last = 0u32;
        let outcome = recall.index(&mut |done, total| {
            // one event per percent-ish rather than per commit: a 40k-commit
            // vault would otherwise post 40k messages into the webview
            if done == total || done - last >= (total / 100).max(1) {
                last = done;
                let _ = app.emit("recall:index", IndexProgress { done, total });
            }
        });
        INDEXING.store(false, Ordering::SeqCst);
        if let Err(e) = &outcome {
            let _ = app.emit("recall:index-error", e.clone());
        }
        outcome
    })
    .await?
}

/// Search the past. Off means empty — never an error, so the toggle in the
/// search pane can ask without having to know the switch's state.
/// `exclude_app_files` mirrors the conceal toggle the live search takes, so
/// the past obeys the same concealment the present does.
#[tauri::command]
pub(crate) fn recall_search(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    q: String,
    exclude_app_files: Option<bool>,
) -> Result<RecallResult, String> {
    let root = state.0.lock().unwrap().root.clone();
    if !crate::appcfg::recall_enabled(&onboarding.config_dir, &root) {
        return Ok(RecallResult { groups: Vec::new(), truncated: false });
    }
    recall_for(&state, &onboarding).search(&q, exclude_app_files.unwrap_or(false))
}
