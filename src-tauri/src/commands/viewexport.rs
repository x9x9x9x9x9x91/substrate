//! Saved view → link folder on disk.
//!
//! Three commands, all explicit: ask where a view exports to, run the
//! export/regenerate, and forget the target when the pin goes away. The
//! mechanics — the marker, the refusal, the deterministic link names — live
//! in `crate::viewexport`; this file is only the IPC edge.

use crate::viewexport;
use crate::{AppState, OnboardingState};
use tauri::State;

/// Where this view exports to on this machine, or `None` if it never has.
/// The UI reads this to decide between "Export…" (ask) and "Regenerate"
/// (silent).
#[tauri::command]
pub(crate) fn view_export_target(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    view_id: String,
) -> Option<String> {
    let root = state.0.lock().unwrap().root.clone();
    viewexport::target_for(&onboarding.config_dir, &root, &view_id).map(|p| p.display().to_string())
}

/// Rebuild `dest` as this view's link folder and remember it as the view's
/// target. `paths` are the vault-relative notes the view matches — the
/// frontend owns the query language, so it decides the rows.
#[tauri::command]
pub(crate) fn view_export_run(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    view_id: String,
    view_name: String,
    dest: String,
    paths: Vec<String>,
) -> Result<viewexport::ExportReport, String> {
    let root = state.0.lock().unwrap().root.clone();
    let dest = std::path::PathBuf::from(dest);
    let generated = chrono::Local::now().to_rfc3339();
    let report = viewexport::export_links(&root, &dest, &view_name, &view_id, &paths, &generated)?;
    // remember only after a successful build: a refused folder must not
    // become the target Regenerate silently retries forever
    viewexport::remember_target(&onboarding.config_dir, &root, &view_id, &dest)?;
    Ok(report)
}

/// Forget a view's remembered target. The folder on disk is never touched —
/// it is the user's to keep or delete.
#[tauri::command]
pub(crate) fn view_export_forget(
    onboarding: State<OnboardingState>,
    view_id: String,
) -> Result<(), String> {
    viewexport::forget_target(&onboarding.config_dir, &view_id)
}
