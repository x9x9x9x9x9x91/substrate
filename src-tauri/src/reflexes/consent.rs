//! The one-time per-vault enable switch (SUB-826, consent amendment).
//!
//! A reflexes file is data, not code — the closed verb set is what makes that
//! true, and it is why editing a rule needs no re-approval. But a vault is a
//! folder that sync copies wholesale, so a `reflexes.json` can ARRIVE on a
//! device the person never armed: from a synced vault, a shared folder, a
//! restored backup. Silent background file rewriting is not something a vault
//! should be able to switch on for you.
//!
//! So: **one switch, per vault, per device, for the whole feature.** Until it
//! is on, rules parse, list, and show as paused in settings, and nothing runs.
//! After it is on, rule edits are just edits — no re-consent, ever, because
//! there is no verb a new rule could reach that the enable did not already
//! cover.
//!
//! Consent lives in `config.json` beside the mount bindings
//! (`appcfg::AppConfig::reflexes`), keyed by canonical vault path — the same
//! shape and the same reasoning as custom kinds (`crate::kinds`): a marker
//! inside the vault would sync, and a synced marker is a courier, not consent.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// One enable decision. `enabledAt` is when, so a decision made on a machine
/// long ago is visible rather than folklore; `paused` is the user's later
/// "stop for now" without discarding the decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Consent {
    pub enabled_at: String,
    #[serde(default)]
    pub paused: bool,
}

impl Consent {
    pub fn now() -> Self {
        Consent {
            enabled_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            paused: false,
        }
    }
}

/// What settings needs to render the Reflexes section, and what the runner
/// needs to decide whether to run at all.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Has this device ever enabled reflexes for this vault?
    pub enabled: bool,
    /// Enabled, then paused by the user.
    pub paused: bool,
    pub enabled_at: Option<String>,
}

impl Status {
    /// The gate the runner asks. Enabled AND not paused — anything else and no
    /// rule executes, whatever the file says.
    pub fn may_run(&self) -> bool {
        self.enabled && !self.paused
    }
}

/// Read this device's decision for one vault. A missing or unreadable config
/// reads as "never enabled" — the safe direction, and the only one that keeps
/// a corrupt config from arming a vault.
pub fn status(cfg_dir: &Path, vault: &Path) -> Status {
    match crate::appcfg::read_config(cfg_dir).reflexes.get(&crate::kinds::vault_key(vault)) {
        None => Status { enabled: false, paused: false, enabled_at: None },
        Some(c) => Status {
            enabled: true,
            paused: c.paused,
            enabled_at: Some(c.enabled_at.clone()),
        },
    }
}

/// The single question the runner asks before doing anything.
pub fn may_run(cfg_dir: &Path, vault: &Path) -> bool {
    status(cfg_dir, vault).may_run()
}

/// Turn reflexes on for this vault on this device. Idempotent in effect: a
/// second enable clears a pause but keeps the original `enabledAt`, so the
/// record stays a history of the decision rather than of the last click.
pub fn enable(cfg_dir: &Path, vault: &Path) -> Result<(), String> {
    let key = crate::kinds::vault_key(vault);
    crate::appcfg::update_config(cfg_dir, |cfg| match cfg.reflexes.get_mut(&key) {
        Some(existing) => existing.paused = false,
        None => {
            cfg.reflexes.insert(key.clone(), Consent::now());
        }
    })
}

/// Pause without forgetting the decision (`paused = true`), or resume.
pub fn set_paused(cfg_dir: &Path, vault: &Path, paused: bool) -> Result<(), String> {
    let key = crate::kinds::vault_key(vault);
    crate::appcfg::update_config(cfg_dir, |cfg| {
        if let Some(existing) = cfg.reflexes.get_mut(&key) {
            existing.paused = paused;
        }
    })
}

/// Withdraw consent entirely — back to the first-run state, so the next
/// `reflexes.json` seen on this device is behind the enable switch again.
pub fn disable(cfg_dir: &Path, vault: &Path) -> Result<(), String> {
    let key = crate::kinds::vault_key(vault);
    crate::appcfg::update_config(cfg_dir, |cfg| {
        cfg.reflexes.remove(&key);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dirs(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "reflex-consent-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&base);
        let cfg = base.join("cfg");
        let vault = base.join("vault");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::create_dir_all(vault.join(".vault")).unwrap();
        (cfg, vault)
    }

    /// The amendment's core claim: a `reflexes.json` that just arrived runs
    /// nothing until someone on THIS device says so.
    #[test]
    fn a_fresh_vault_may_not_run() {
        let (cfg, vault) = dirs("fresh");
        let s = status(&cfg, &vault);
        assert!(!s.enabled, "never enabled");
        assert!(!s.may_run(), "and therefore may not run");
        assert!(s.enabled_at.is_none());
        assert!(!may_run(&cfg, &vault));
    }

    #[test]
    fn enabling_is_recorded_and_lets_rules_run() {
        let (cfg, vault) = dirs("enable");
        enable(&cfg, &vault).unwrap();
        let s = status(&cfg, &vault);
        assert!(s.enabled && !s.paused && s.may_run());
        assert!(s.enabled_at.is_some(), "when the decision was made is recorded");
        // …outside the vault, where sync cannot carry it
        let text = std::fs::read_to_string(cfg.join(crate::appcfg::CONFIG_FILE)).unwrap();
        assert!(text.contains("reflexes"), "{text}");
        assert!(!vault.join(".vault/reflexes-consent.json").exists());
    }

    #[test]
    fn pausing_keeps_the_decision_but_stops_execution() {
        let (cfg, vault) = dirs("pause");
        enable(&cfg, &vault).unwrap();
        let first = status(&cfg, &vault).enabled_at.unwrap();
        set_paused(&cfg, &vault, true).unwrap();
        let s = status(&cfg, &vault);
        assert!(s.enabled, "still consented");
        assert!(s.paused);
        assert!(!s.may_run(), "but nothing runs");
        // re-enabling clears the pause and keeps the original date
        enable(&cfg, &vault).unwrap();
        let s = status(&cfg, &vault);
        assert!(s.may_run());
        assert_eq!(s.enabled_at.as_deref(), Some(first.as_str()));
    }

    #[test]
    fn disabling_returns_to_the_first_run_state() {
        let (cfg, vault) = dirs("disable");
        enable(&cfg, &vault).unwrap();
        disable(&cfg, &vault).unwrap();
        assert!(!status(&cfg, &vault).enabled);
        assert!(!may_run(&cfg, &vault));
    }

    /// Consent is per vault: enabling one must not arm another, and the same
    /// vault reached by a different-but-equivalent path is one decision.
    #[test]
    fn consent_is_keyed_per_vault() {
        let (cfg, vault) = dirs("per-vault");
        let other = vault.parent().unwrap().join("other");
        std::fs::create_dir_all(other.join(".vault")).unwrap();
        enable(&cfg, &vault).unwrap();
        assert!(may_run(&cfg, &vault));
        assert!(!may_run(&cfg, &other), "a second vault is a second decision");

        let indirect = vault.join(".").join("..").join(vault.file_name().unwrap());
        assert!(may_run(&cfg, &indirect), "canonical path = one decision");
    }

    /// Consent must not clobber the config's other concerns — the whole
    /// reason `update_config` exists.
    #[test]
    fn enabling_preserves_the_rest_of_the_config() {
        let (cfg, vault) = dirs("preserve");
        crate::appcfg::write_vault_choice(&cfg, &vault).unwrap();
        crate::appcfg::write_mount_binding(&cfg, "pool", Some(Path::new("/tmp/pool"))).unwrap();
        enable(&cfg, &vault).unwrap();
        let back = crate::appcfg::read_config(&cfg);
        assert_eq!(back.vault.as_deref(), Some(vault.as_path()));
        assert_eq!(back.mounts.get("pool").map(|p| p.as_path()), Some(Path::new("/tmp/pool")));
        assert_eq!(back.reflexes.len(), 1);
    }

    #[test]
    fn an_unparsable_config_reads_as_not_enabled() {
        let (cfg, vault) = dirs("corrupt");
        enable(&cfg, &vault).unwrap();
        std::fs::write(cfg.join(crate::appcfg::CONFIG_FILE), "{ broken").unwrap();
        assert!(!may_run(&cfg, &vault), "a corrupt config must not arm a vault");
    }

    /// Pausing a vault that was never enabled is a no-op, not an accidental
    /// enable through the back door.
    #[test]
    fn pausing_an_unconsented_vault_does_not_enable_it() {
        let (cfg, vault) = dirs("no-backdoor");
        set_paused(&cfg, &vault, false).unwrap();
        assert!(!status(&cfg, &vault).enabled);
        assert!(!may_run(&cfg, &vault));
    }
}
