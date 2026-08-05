//! Reflexes: the one-time per-vault enable switch, what the rules file says,
//! and what the rules have actually been doing (SUB-826).
//!
//! Five commands and no sixth: nothing here writes `reflexes.json`. Rules are
//! authored in the file — the app reads them, reports them, and decides whether
//! they may run on this device. Keeping rule authoring out of the app is what
//! keeps the file the single source of truth, the same way keeping bundle
//! install out of the app is what makes the kinds enable card meaningful
//! (`commands::kinds`).
//!
//! Consent is written to `config.json` in the OS app-config dir, keyed by
//! canonical vault path. See `crate::reflexes::consent` for why it cannot live
//! in the vault.

use crate::reflexes::{self, consent, run, InvalidRule};
use crate::{AppState, OnboardingState};
use serde::Serialize;
use tauri::State;

/// One rule as the settings pane shows it: what the file says, plus what the
/// runtime remembers about it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuleView {
    pub id: String,
    pub event: String,
    pub path: Option<String>,
    pub actions: Vec<String>,
    /// The file's own switch.
    pub enabled: bool,
    pub dry_run: bool,
    /// Paused by the circuit breaker after repeated failures — runtime state,
    /// never written back to the file.
    pub auto_paused: bool,
    pub last_fired: Option<String>,
    pub last_error: Option<String>,
    pub suppressed: u32,
}

/// Everything the Reflexes settings section renders in one round trip, so the
/// list can never be one call stale against the switch that governs it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReflexStatus {
    /// Has this device ever enabled reflexes for this vault?
    pub enabled: bool,
    /// Enabled, then paused by the user.
    pub paused: bool,
    pub enabled_at: Option<String>,
    /// The file's own top-level kill switch — a different switch from `paused`.
    pub file_paused: bool,
    /// Is there a rules file at all?
    pub has_file: bool,
    /// Why the file didn't load, when it didn't.
    pub error: Option<String>,
    pub rules: Vec<RuleView>,
    pub invalid: Vec<InvalidRule>,
}

#[tauri::command]
pub(crate) fn reflexes_status(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    reflexes: State<reflexes::ReflexState>,
) -> ReflexStatus {
    let root = state.0.lock().unwrap().root.clone();
    let status = consent::status(&onboarding.config_dir, &root);
    let loaded = reflexes.0.lock().unwrap();
    let rules = loaded
        .reflexes
        .rules
        .iter()
        .map(|r| {
            let st = loaded.runtime.state(&r.id);
            RuleView {
                id: r.id.clone(),
                event: r.event.as_str().to_string(),
                path: r.path.clone(),
                actions: r.actions.iter().map(|a| a.verb().to_string()).collect(),
                enabled: r.enabled,
                dry_run: r.dry_run,
                auto_paused: st.map(|s| s.auto_paused).unwrap_or(false),
                last_fired: st.and_then(|s| s.last_fired.clone()),
                last_error: st.and_then(|s| s.last_error.clone()),
                suppressed: st.map(|s| s.suppressed).unwrap_or(0),
            }
        })
        .collect();
    ReflexStatus {
        enabled: status.enabled,
        paused: status.paused,
        enabled_at: status.enabled_at,
        file_paused: loaded.reflexes.paused,
        has_file: root.join(reflexes::CONFIG_REL_PATH).is_file(),
        error: loaded.error.clone(),
        rules,
        invalid: loaded.reflexes.invalid.clone(),
    }
}

/// Arm reflexes for this vault on this device. One switch for the whole
/// feature: after this, rule edits are just edits (the closed verb set is what
/// makes that safe — see `crate::reflexes::consent`).
#[tauri::command]
pub(crate) fn reflexes_enable(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
) -> Result<(), String> {
    if cfg!(target_os = "ios") {
        return Err("reflexes run on desktop only".into());
    }
    let root = state.0.lock().unwrap().root.clone();
    consent::enable(&onboarding.config_dir, &root)
}

/// Stop for now, keeping the decision. Unlike `reflexes_disable` this does not
/// return the vault to its never-armed state, so re-arming is one click and not
/// a fresh grant of trust.
#[tauri::command]
pub(crate) fn reflexes_set_paused(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    paused: bool,
) -> Result<(), String> {
    let root = state.0.lock().unwrap().root.clone();
    consent::set_paused(&onboarding.config_dir, &root, paused)
}

/// Withdraw the enable entirely: back to the first-run state, rules shown but
/// never run.
#[tauri::command]
pub(crate) fn reflexes_disable(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
) -> Result<(), String> {
    let root = state.0.lock().unwrap().root.clone();
    consent::disable(&onboarding.config_dir, &root)
}

/// The receipts, newest first. Read straight off `.vault/reflexes-log.json`,
/// which is the record — the runtime keeps no second copy to drift from it.
#[tauri::command]
pub(crate) fn reflexes_receipts(state: State<AppState>) -> Vec<run::Receipt> {
    let root = state.0.lock().unwrap().root.clone();
    let mut out = run::read_log(&root);
    out.reverse();
    out
}
