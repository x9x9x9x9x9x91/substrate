//! The `dashboard: jobs` surface's commands — a window onto the machine's
//! launchd agents. launchd owns the clock: nothing here schedules anything,
//! it reports what the scheduler already knows and offers three verbs against
//! the jobs the note opted in to.
//!
//! The note supplies the label allowlist (`prefixes:`), so this file hardcodes
//! no job and no estate; jobs.rs owns discovery, validation and the argv that
//! reaches launchctl. These are thin wrappers, split out of the machine-bridge
//! module so the surface can ship in the shared mirror.

use crate::jobs;

/// Is launchd the scheduler on this machine at all? The pane gates its whole
/// control column on this rather than offering verbs that could only fail —
/// the same discipline the feed dashboard's curator probe follows.
#[tauri::command]
pub(crate) fn jobs_available() -> bool {
    jobs::available()
}

/// Job health across the note's prefix allowlist. Empty `prefixes` = the
/// module defaults. Every read also samples each job's (pid, last exit) into
/// the per-label exit ring at `.vault/jobs-exit.json` — read-only
/// toward launchd; the only write is the app-side state file.
#[tauri::command]
pub(crate) fn jobs_read(
    state: tauri::State<crate::AppState>,
    prefixes: Vec<String>,
) -> Result<Vec<jobs::Job>, String> {
    let root = state.0.lock().unwrap_or_else(|e| e.into_inner()).root.clone();
    jobs::read(&root, &prefixes)
}

/// pause | resume | run for one job. The label is validated against the jobs
/// actually discovered under an allowed prefix before it reaches argv.
#[tauri::command]
pub(crate) fn jobs_control(
    label: String,
    action: String,
    prefixes: Vec<String>,
) -> Result<jobs::JobRun, String> {
    jobs::control(&label, &action, &prefixes)
}

/// Artifact-freshness probes: does the thing this job produces still look
/// recent? A job can be loaded, green and quietly producing nothing.
#[tauri::command]
pub(crate) fn jobs_freshness(
    state: tauri::State<crate::AppState>,
    specs: Vec<String>,
) -> Vec<jobs::Freshness> {
    let root = state.0.lock().unwrap_or_else(|e| e.into_inner()).root.clone();
    jobs::freshness(&root, &specs)
}
