//! Custom dashboard kinds: list what is installed, record consent, withdraw
//! it (SUB-959), and carry the standing "trust updates" rider (SUB-961).
//!
//! Four commands and no fifth: nothing here installs, edits or removes a
//! bundle. A kind arrives in the vault the way any other file does — the user
//! puts it there — and these commands only decide whether its bytes are ever
//! served. Keeping install out of the app is what makes the enable card the
//! single moment where trust is granted.
//!
//! Consent is written to `kinds.json` in the OS app-config dir, keyed by
//! canonical vault path. See `crate::kinds` for why it cannot live in the
//! vault.

use crate::kinds::{self, KindBundle, KindEnableRecord};
use crate::{AppState, OnboardingState};
use tauri::State;

/// Every bundle under `.vault/kinds/`, each with the consent record for this
/// vault when there is one — enough for the frontend to run `resolveKindState`
/// without a second round trip, so the list can never be one call stale
/// against the record it is judged by.
#[tauri::command]
pub(crate) fn kinds_list(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
) -> Vec<KindBundle> {
    let (root, ids) = {
        let engine = state.0.lock().unwrap();
        (engine.root.clone(), engine.kind_ids())
    };
    kinds::list_bundles(&root, &onboarding.config_dir, &ids)
}

/// Record consent for `id` at exactly `hash`.
///
/// The caller passes the hash it showed the user, and it must still be the
/// hash on disk: if the bundle changed between the card being drawn and the
/// button being pressed, the enable is refused rather than applied to bytes
/// nobody read. That is also why re-enabling is how a hash drift is cleared —
/// the same deliberate look at the same card.
#[tauri::command]
pub(crate) fn kinds_enable(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    id: String,
    hash: String,
) -> Result<(), String> {
    if cfg!(target_os = "ios") {
        return Err("custom dashboard kinds are not available on iOS yet".into());
    }
    if !kinds::is_valid_kind_id(&id) {
        return Err(format!("\"{id}\" is not a valid kind id"));
    }
    if kinds::BUILT_IN_KINDS.contains(&id.as_str()) {
        return Err(format!(
            "\"{id}\" is a built-in dashboard kind — rename the folder to something else"
        ));
    }

    let (root, ids) = {
        let engine = state.0.lock().unwrap();
        (engine.root.clone(), engine.kind_ids())
    };
    if !ids.iter().any(|i| i == &id) {
        return Err(format!("no kind \"{id}\" in this vault"));
    }
    let bundle = kinds::list_bundles(&root, &onboarding.config_dir, std::slice::from_ref(&id))
        .into_iter()
        .next()
        .ok_or_else(|| format!("no kind \"{id}\" in this vault"))?;
    let manifest = bundle.manifest_ok().ok_or_else(|| {
        bundle.manifest.reason.clone().unwrap_or_else(|| "kind.json is invalid".into())
    })?;

    if bundle.hash != hash {
        return Err(
            "this kind's files changed since you looked at them — review it again before enabling"
                .into(),
        );
    }
    if manifest.api > kinds::KIND_API {
        return Err(format!(
            "\"{id}\" needs a newer Substrate (it speaks kind api {}, this build speaks {})",
            manifest.api,
            kinds::KIND_API
        ));
    }
    if manifest.api < kinds::KIND_API_MIN {
        return Err(format!(
            "\"{id}\" was written for kind api {}, which this build no longer mounts",
            manifest.api
        ));
    }

    // A re-enable after a drift carries the standing permission forward. The
    // record is overwritten wholesale, so reading the old one first is what
    // keeps "trust updates to this kind" from silently switching itself off
    // the first time the code it was granted for actually changed — which is
    // the only situation it exists for.
    let trust_updates = bundle.record.as_ref().is_some_and(|r| r.trust_updates);

    kinds::set_enabled(
        &onboarding.config_dir,
        &root,
        &id,
        KindEnableRecord {
            hash,
            api: manifest.api,
            enabled_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            trust_updates,
        },
    )
}

/// Turn the standing "trust updates to this kind in this vault" permission on
/// or off. Only ever edits a record that already exists: this is a rider on a
/// consent someone gave by reading the code, never a way to grant one. Turning
/// it on for a kind that isn't enabled is a silent no-op for the same reason
/// `kinds_disable` doesn't mind an unknown id — the resulting state ("nothing
/// runs unreviewed") is identical either way.
#[tauri::command]
pub(crate) fn kinds_set_trust(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    id: String,
    trust: bool,
) -> Result<(), String> {
    if cfg!(target_os = "ios") {
        return Err("custom dashboard kinds are not available on iOS yet".into());
    }
    let root = state.0.lock().unwrap().root.clone();
    kinds::set_trust_updates(&onboarding.config_dir, &root, &id, trust).map(|_| ())
}

/// Withdraw consent. Never fails on an unknown id — "this must not run" is
/// the same outcome whether a record existed or not, and a bundle deleted
/// from the vault still has to be revocable.
#[tauri::command]
pub(crate) fn kinds_disable(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    id: String,
) -> Result<(), String> {
    let root = state.0.lock().unwrap().root.clone();
    kinds::clear_enabled(&onboarding.config_dir, &root, &id)
}
