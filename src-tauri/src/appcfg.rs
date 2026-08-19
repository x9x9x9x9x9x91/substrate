//! Per-machine app config: which vault this install opens.
//!
//! The file lives in the OS app-config dir (`~/Library/Application
//! Support/<bundle id>/config.json` on macOS) — deliberately NOT
//! inside any vault, because it records *which* vault to open and a vault
//! that moves or syncs must never carry a stale pointer to itself.
//!
//! Resolution order (`resolve_vault`):
//!   1. `VAULT_DIR` env — every dev/test/script flow keeps working untouched,
//!      including pointing at a scratch dir that does not exist yet.
//!   2. the stored choice, when it still exists and looks like a vault.
//!   3. the platform default (`~/Vault`) when it exists and looks like a
//!      vault — adopted silently and written to the config, so an install
//!      that predates onboarding boots exactly as it always did.
//!   4. otherwise: first run, and the UI asks.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// `config.json` inside the app-config dir.
pub const CONFIG_FILE: &str = "config.json";

/// Marker directory every Substrate vault carries once it has any config.
const VAULT_MARKER: &str = ".vault";

/// The per-machine config file. Unknown keys are preserved-by-ignoring: this
/// struct stays small on purpose, one concern per field.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AppConfig {
    /// Absolute path of the vault this install opens. `None` = never chosen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault: Option<PathBuf>,
    /// Where each mounted folder lives ON THIS MACHINE: mount id → absolute
    /// path. A mount's identity, name and globs are portable and
    /// sync inside the vault; the path binding is per-machine and must not,
    /// which is exactly why it lives here and not in `.vault/mounts.json`.
    /// A mount with no entry here is unbound: its board still renders from
    /// the last-known index, with a "Locate folder…" affordance.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub mounts: std::collections::BTreeMap<String, PathBuf>,
    /// Which vaults may run reflexes ON THIS DEVICE: canonical vault path →
    /// the enable decision. One switch for the whole feature, per
    /// vault, per device. It lives here rather than in the vault for the same
    /// reason custom-kind consent does (`crate::kinds`): a vault syncs
    /// wholesale, so a marker inside it would arrive pre-approved everywhere.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub reflexes: std::collections::BTreeMap<String, crate::reflexes::consent::Consent>,
    /// Which vaults keep a Deep Recall index ON THIS DEVICE: canonical vault
    /// path → the opt-in. Per-device for the same reason as `reflexes`, plus
    /// one of its own: the index is a device-local SQLite file whose size and
    /// first-build cost are this machine's to pay, so the decision cannot ride
    /// along on a sync.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub recall: std::collections::BTreeMap<String, bool>,
    /// Volumes this DEVICE will not catalog: the volume ids of drives the
    /// user asked the shelf to forget. Machine-local for the same reason
    /// reflex consent is — cataloging happens on the machine the disk is
    /// plugged into, so "don't catalog this" is a decision about this
    /// machine's behaviour, not a fact about the disk. A drive forgotten
    /// here and plugged into another machine is cataloged there, and the
    /// shelf says so rather than pretending otherwise.
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub drives_ignored: std::collections::BTreeSet<String>,
}

/// Where a resolved root came from — the caller uses this to decide whether
/// the choice still needs persisting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `VAULT_DIR` was set; never persisted (it is a per-run override).
    Env,
    /// Read back from `config.json`.
    Stored,
    /// The platform default, adopted because it already holds a vault.
    AdoptedDefault,
}

/// Outcome of resolution: a root to open, or "ask the user".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Root(PathBuf, Source),
    FirstRun,
}

/// Read `config.json`; a missing or unparsable file is an empty config —
/// never a boot failure.
pub fn read_config(cfg_dir: &Path) -> AppConfig {
    fs::read_to_string(cfg_dir.join(CONFIG_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Read the config, let `edit` change it, write it back. EVERY write goes
/// through here: the config has grown a second concern (mount path bindings)
/// and a writer that builds a fresh `AppConfig` from one field
/// silently drops the other. Creating the config dir is part of the write.
pub fn update_config(cfg_dir: &Path, edit: impl FnOnce(&mut AppConfig)) -> Result<(), String> {
    fs::create_dir_all(cfg_dir).map_err(|e| e.to_string())?;
    let mut cfg = read_config(cfg_dir);
    edit(&mut cfg);
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(cfg_dir.join(CONFIG_FILE), format!("{json}\n")).map_err(|e| e.to_string())
}

/// Persist the chosen vault path, creating the config dir if needed. Other
/// fields (mount bindings) survive the write.
pub fn write_vault_choice(cfg_dir: &Path, vault: &Path) -> Result<(), String> {
    update_config(cfg_dir, |cfg| cfg.vault = Some(vault.to_path_buf()))
}

/// Is Deep Recall on for this vault on this machine? Absent = off: the
/// feature is opt-in, so no answer is a "no".
pub fn recall_enabled(cfg_dir: &Path, vault: &Path) -> bool {
    read_config(cfg_dir).recall.get(&crate::kinds::vault_key(vault)).copied().unwrap_or(false)
}

/// Record the Deep Recall opt-in. Turning it off REMOVES the entry rather
/// than storing `false`, so a vault that was never asked and a vault that
/// said no read the same on every other machine's config too.
pub fn write_recall_enabled(cfg_dir: &Path, vault: &Path, enabled: bool) -> Result<(), String> {
    let key = crate::kinds::vault_key(vault);
    update_config(cfg_dir, |cfg| {
        if enabled {
            cfg.recall.insert(key.clone(), true);
        } else {
            cfg.recall.remove(&key);
        }
    })
}

/// Bind a mount to a path on THIS machine, or clear the binding with `None`.
pub fn write_mount_binding(cfg_dir: &Path, id: &str, path: Option<&Path>) -> Result<(), String> {
    update_config(cfg_dir, |cfg| match path {
        Some(p) => {
            cfg.mounts.insert(id.to_string(), p.to_path_buf());
        }
        None => {
            cfg.mounts.remove(id);
        }
    })
}

/// Stop cataloging a volume on this machine, or allow it again.
pub fn write_drive_ignored(cfg_dir: &Path, volume: &str, ignored: bool) -> Result<(), String> {
    update_config(cfg_dir, |cfg| {
        if ignored {
            cfg.drives_ignored.insert(volume.to_string());
        } else {
            cfg.drives_ignored.remove(volume);
        }
    })
}

/// How sure do we need to be that a folder is a vault?
///
/// The two callers want different answers, and conflating them is what let a
/// folder with one stray `README.md` open silently as a vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    /// Adopting `~/Vault` at boot, unasked. A pre-marker vault often holds a
    /// single top-level note, and refusing to adopt it would put an
    /// onboarding screen in front of an existing user — so one `.md` counts.
    Adopting,
    /// A folder the user just picked. The same loose rule here means picking
    /// `~/Documents` or a code checkout (one `README.md`) silently opens it
    /// as a vault and writes `.vault/` into it, with no consent step. So a
    /// pick needs the `.vault/` marker or at least two top-level `.md` files.
    Picked,
}

/// Number of top-level `.md` files, counting at most `cap` (so a huge folder
/// is not walked further than the decision needs).
fn top_level_md_count(p: &Path, cap: usize) -> usize {
    fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("md")))
                .take(cap)
                .count()
        })
        .unwrap_or(0)
}

/// Does this folder already hold a vault, at the given confidence? The
/// `.vault/` marker is conclusive either way; the markdown fallback is what
/// the two levels disagree about.
pub fn looks_like_vault_at(p: &Path, confidence: Confidence) -> bool {
    if p.join(VAULT_MARKER).is_dir() {
        return true;
    }
    let need = match confidence {
        Confidence::Adopting => 1,
        Confidence::Picked => 2,
    };
    top_level_md_count(p, need) >= need
}

/// Is there markdown in a SUBFOLDER of `p`? Purely descriptive — it changes
/// no verdict, only which consent wording the picker uses: a
/// folder-organised Obsidian vault (`Daily/`, `Projects/`, nothing loose at
/// the root) fails the strict top-level test and must not be greeted as
/// "this folder already holds other files".
///
/// Bounded on purpose: hidden folders are skipped (a `.git/` full of
/// markdown says nothing about notes), depth stops at
/// [`NESTED_MD_MAX_DEPTH`], and the walk visits at most
/// [`NESTED_MD_MAX_DIRS`] directories, so picking `~` costs a blink rather
/// than a full-disk crawl.
fn has_nested_markdown(p: &Path) -> bool {
    const NESTED_MD_MAX_DEPTH: usize = 3;
    const NESTED_MD_MAX_DIRS: usize = 200;

    let mut queue: Vec<(PathBuf, usize)> = vec![(p.to_path_buf(), 0)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop() {
        visited += 1;
        if visited > NESTED_MD_MAX_DIRS {
            return false;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let path = e.path();
            if path.is_dir() {
                if depth + 1 < NESTED_MD_MAX_DEPTH {
                    queue.push((path, depth + 1));
                }
            } else if depth > 0 && path.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
                return true;
            }
        }
    }
    false
}

/// The loose test, kept for the boot-time adoption path. See
/// [`looks_like_vault_at`] for why picking uses the stricter one.
pub fn looks_like_vault(p: &Path) -> bool {
    looks_like_vault_at(p, Confidence::Adopting)
}

/// True when the folder does not exist, or exists with no visible entries.
/// Dotfiles alone (`.DS_Store`) still count as empty — a Finder artifact is
/// not user content.
pub fn is_effectively_empty(p: &Path) -> bool {
    match fs::read_dir(p) {
        Err(_) => true,
        Ok(rd) => !rd.flatten().any(|e| !e.file_name().to_string_lossy().starts_with('.')),
    }
}

/// Resolve which vault to open. Pure over its inputs so the order is testable
/// without a Tauri app handle; `env` is `VAULT_DIR`'s value when set.
pub fn resolve_vault(cfg_dir: &Path, env: Option<&str>, default_root: &Path) -> Resolution {
    if let Some(v) = env.map(str::trim).filter(|s| !s.is_empty()) {
        // an env root is honoured verbatim, existing or not — scratch-dir
        // dev flows depend on the engine creating and seeding it
        return Resolution::Root(PathBuf::from(v), Source::Env);
    }
    if let Some(stored) = read_config(cfg_dir).vault {
        // a stored path that vanished (vault moved or deleted) falls through
        // to first run rather than silently reseeding an empty folder
        if stored.is_dir() && looks_like_vault(&stored) {
            return Resolution::Root(stored, Source::Stored);
        }
    }
    if default_root.is_dir() && looks_like_vault(default_root) {
        return Resolution::Root(default_root.to_path_buf(), Source::AdoptedDefault);
    }
    Resolution::FirstRun
}

/// What `vault_inspect` reports about a candidate folder, so the UI can name
/// the exact action ("Open vault" / "Initialize here" / refuse).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultCandidate {
    pub path: String,
    pub exists: bool,
    pub is_vault: bool,
    /// Non-empty and not a vault: initializing here needs explicit consent.
    pub empty: bool,
    /// Markdown lives in subfolders. Never changes what is
    /// allowed — only which consent wording the picker shows, so a
    /// folder-organised notes vault isn't greeted as a stranger's folder.
    #[serde(default)]
    pub nested_markdown: bool,
    /// The `.vault/` marker is already here — this folder has been a Substrate
    /// vault before. `is_vault` is NOT the same question: a plain
    /// folder with two top-level notes also earns "Open vault", and adopting
    /// that one really does add Substrate's files. Descriptive only: it
    /// changes no verdict, just which sentence the picker owes the user.
    #[serde(default)]
    pub has_marker: bool,
}

pub fn inspect(p: &Path) -> VaultCandidate {
    let is_dir = p.is_dir();
    VaultCandidate {
        path: p.to_string_lossy().into_owned(),
        exists: is_dir,
        // a picked folder is judged strictly: one stray README.md must reach
        // the consent screen, not open silently as a vault
        is_vault: is_dir && looks_like_vault_at(p, Confidence::Picked),
        empty: is_effectively_empty(p),
        nested_markdown: is_dir && has_nested_markdown(p),
        has_marker: is_dir && p.join(VAULT_MARKER).is_dir(),
    }
}

/// Validate-and-initialize in one step. Returns whether the caller should let
/// the engine seed starter notes (true only for a folder we just created or
/// that was empty).
///
/// Never writes into a folder that holds unrelated content unless `consent`
/// says the user explicitly chose "initialize here".
pub fn open_or_init(p: &Path, consent: bool) -> Result<bool, String> {
    if p.exists() && !p.is_dir() {
        return Err(format!("{} is a file, not a folder", p.display()));
    }
    let existed = p.is_dir();
    // strict: this is a pick, so a lone README.md is content to be consented
    // to, not a vault to adopt
    if existed && looks_like_vault_at(p, Confidence::Picked) {
        // already a vault: adopt as-is, no seeding, marker backfilled
        fs::create_dir_all(p.join(VAULT_MARKER)).map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let empty = is_effectively_empty(p);
    if existed && !empty && !consent {
        return Err(format!(
            "{} already holds other files — confirm initializing a vault here",
            p.display()
        ));
    }
    fs::create_dir_all(p.join(VAULT_MARKER)).map_err(|e| e.to_string())?;
    // seed only into a folder that had nothing in it; adopting a folder of
    // existing files must not sprinkle sample notes among them
    Ok(!existed || empty)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault_at(dir: &Path) -> PathBuf {
        let v = dir.join("V");
        fs::create_dir_all(v.join(".vault")).unwrap();
        v
    }

    /// The two concerns in `config.json` are written by different
    /// flows (picking a vault; binding a mount), and each used to be able to
    /// erase the other by rebuilding the struct from its own field.
    #[test]
    fn config_writes_do_not_drop_each_other() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        write_vault_choice(&cfg, Path::new("/tmp/v")).unwrap();
        write_mount_binding(&cfg, "m1", Some(Path::new("/tmp/pool"))).unwrap();

        // binding a mount kept the vault choice
        assert_eq!(read_config(&cfg).vault.as_deref(), Some(Path::new("/tmp/v")));
        assert_eq!(
            read_config(&cfg).mounts.get("m1").cloned().as_deref(),
            Some(Path::new("/tmp/pool"))
        );

        // and re-picking a vault keeps the bindings
        write_vault_choice(&cfg, Path::new("/tmp/v2")).unwrap();
        assert_eq!(
            read_config(&cfg).mounts.get("m1").cloned().as_deref(),
            Some(Path::new("/tmp/pool"))
        );

        // unbinding removes just that mount
        write_mount_binding(&cfg, "m2", Some(Path::new("/tmp/other"))).unwrap();
        write_mount_binding(&cfg, "m1", None).unwrap();
        assert_eq!(read_config(&cfg).mounts.get("m1").cloned(), None);
        assert_eq!(
            read_config(&cfg).mounts.get("m2").cloned().as_deref(),
            Some(Path::new("/tmp/other"))
        );
        assert_eq!(read_config(&cfg).vault.as_deref(), Some(Path::new("/tmp/v2")));
    }

    /// Deep Recall is opt-in per vault per device, and switching it off must
    /// leave no trace that could read as a decision on another machine.
    #[test]
    fn recall_opt_in_is_off_until_asked_for_and_forgotten_when_withdrawn() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        let vault = vault_at(t.path());
        write_vault_choice(&cfg, &vault).unwrap();
        assert!(!recall_enabled(&cfg, &vault), "never asked = off");

        write_recall_enabled(&cfg, &vault, true).unwrap();
        assert!(recall_enabled(&cfg, &vault));
        // a non-canonical spelling of the same vault is the same decision
        let indirect = vault.join(".vault").join("..");
        assert!(recall_enabled(&cfg, &indirect));
        // and the rest of the config survived the write
        assert_eq!(read_config(&cfg).vault.as_deref(), Some(vault.as_path()));

        write_recall_enabled(&cfg, &vault, false).unwrap();
        assert!(!recall_enabled(&cfg, &vault));
        assert!(read_config(&cfg).recall.is_empty(), "withdrawing leaves no entry behind");
    }

    #[test]
    fn env_wins_over_everything_and_need_not_exist() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        let stored = vault_at(t.path());
        write_vault_choice(&cfg, &stored).unwrap();
        let default = vault_at(&{
            let d = t.path().join("home");
            fs::create_dir_all(&d).unwrap();
            d
        });
        let missing = t.path().join("scratch-not-created");
        assert_eq!(
            resolve_vault(&cfg, Some(missing.to_str().unwrap()), &default),
            Resolution::Root(missing, Source::Env)
        );
    }

    #[test]
    fn empty_env_is_ignored() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        let default = vault_at(t.path());
        assert_eq!(
            resolve_vault(&cfg, Some("  "), &default),
            Resolution::Root(default, Source::AdoptedDefault)
        );
    }

    #[test]
    fn stored_choice_beats_default() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        let stored = t.path().join("chosen");
        fs::create_dir_all(stored.join(".vault")).unwrap();
        let default = vault_at(t.path());
        write_vault_choice(&cfg, &stored).unwrap();
        assert_eq!(resolve_vault(&cfg, None, &default), Resolution::Root(stored, Source::Stored));
    }

    #[test]
    fn stored_choice_that_vanished_falls_through_to_first_run() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        write_vault_choice(&cfg, &t.path().join("gone")).unwrap();
        assert_eq!(resolve_vault(&cfg, None, &t.path().join("no-default")), Resolution::FirstRun);
    }

    /// The common boot: no stored choice, `~/Vault` present — adopt silently.
    #[test]
    fn existing_default_vault_is_adopted_without_asking() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        let default = vault_at(t.path());
        assert_eq!(
            resolve_vault(&cfg, None, &default),
            Resolution::Root(default, Source::AdoptedDefault)
        );
    }

    /// A pre-marker vault (markdown at top level, no `.vault/`) is still a
    /// vault — an existing user never sees onboarding.
    #[test]
    fn default_with_markdown_but_no_marker_is_adopted() {
        let t = TempDir::new().unwrap();
        let default = t.path().join("Vault");
        fs::create_dir_all(&default).unwrap();
        fs::write(default.join("Welcome.md"), "hi").unwrap();
        assert_eq!(
            resolve_vault(&t.path().join("cfg"), None, &default),
            Resolution::Root(default, Source::AdoptedDefault)
        );
    }

    #[test]
    fn nothing_anywhere_is_first_run() {
        let t = TempDir::new().unwrap();
        assert_eq!(
            resolve_vault(&t.path().join("cfg"), None, &t.path().join("Vault")),
            Resolution::FirstRun
        );
    }

    #[test]
    fn empty_default_folder_is_not_a_vault() {
        let t = TempDir::new().unwrap();
        let default = t.path().join("Vault");
        fs::create_dir_all(&default).unwrap();
        assert_eq!(resolve_vault(&t.path().join("cfg"), None, &default), Resolution::FirstRun);
    }

    #[test]
    fn config_roundtrips_and_a_broken_file_is_not_fatal() {
        let t = TempDir::new().unwrap();
        let cfg = t.path().join("cfg");
        write_vault_choice(&cfg, Path::new("/tmp/x")).unwrap();
        assert_eq!(read_config(&cfg).vault, Some(PathBuf::from("/tmp/x")));
        fs::write(cfg.join(CONFIG_FILE), "{not json").unwrap();
        assert_eq!(read_config(&cfg).vault, None);
    }

    #[test]
    fn init_creates_a_new_vault_and_asks_for_seeding() {
        let t = TempDir::new().unwrap();
        let fresh = t.path().join("New Vault");
        assert_eq!(open_or_init(&fresh, false), Ok(true));
        assert!(fresh.join(".vault").is_dir());
        assert!(looks_like_vault(&fresh));
    }

    #[test]
    fn init_adopts_an_existing_vault_without_seeding() {
        let t = TempDir::new().unwrap();
        let v = vault_at(t.path());
        fs::write(v.join("Note.md"), "x").unwrap();
        assert_eq!(open_or_init(&v, false), Ok(false));
    }

    #[test]
    fn init_refuses_a_non_vault_folder_with_content_until_consent() {
        let t = TempDir::new().unwrap();
        let d = t.path().join("Downloads");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("invoice.pdf"), "x").unwrap();
        assert!(open_or_init(&d, false).is_err());
        assert!(!d.join(".vault").exists(), "refusal must not write anything");
        // consent adopts in place — and never seeds sample notes among the
        // user's own files
        assert_eq!(open_or_init(&d, true), Ok(false));
        assert!(d.join(".vault").is_dir());
    }

    #[test]
    fn init_treats_a_dotfile_only_folder_as_empty() {
        let t = TempDir::new().unwrap();
        let d = t.path().join("Empty");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(".DS_Store"), "x").unwrap();
        assert_eq!(open_or_init(&d, false), Ok(true));
    }

    #[test]
    fn init_rejects_a_file_path() {
        let t = TempDir::new().unwrap();
        let f = t.path().join("note.md");
        fs::write(&f, "x").unwrap();
        assert!(open_or_init(&f, true).is_err());
    }

    /// Review #4: one stray `.md` used to be enough for any folder to
    /// count as a vault, so picking `~/Documents` or a code checkout with a
    /// single `README.md` opened it silently and wrote `.vault/` into it.
    #[test]
    fn a_picked_folder_with_one_stray_md_is_not_a_vault() {
        let t = TempDir::new().unwrap();
        let repo = t.path().join("some-checkout");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("README.md"), "# project").unwrap();
        fs::write(repo.join("main.rs"), "fn main() {}").unwrap();

        assert!(!looks_like_vault_at(&repo, Confidence::Picked));
        let i = inspect(&repo);
        assert!(i.exists && !i.is_vault && !i.empty, "the UI must ask for consent: {i:?}");

        // and the write path refuses without that consent, writing nothing
        assert!(open_or_init(&repo, false).is_err());
        assert!(!repo.join(VAULT_MARKER).exists(), "refusal must not write anything");
    }

    /// The other side of the split: a legacy `~/Vault` holding a single note
    /// and no marker is still adopted silently at boot.
    #[test]
    fn adoption_still_accepts_a_legacy_vault_with_one_md() {
        let t = TempDir::new().unwrap();
        let default = t.path().join("Vault");
        fs::create_dir_all(&default).unwrap();
        fs::write(default.join("Welcome.md"), "hi").unwrap();

        assert!(looks_like_vault_at(&default, Confidence::Adopting));
        assert!(!looks_like_vault_at(&default, Confidence::Picked));
        assert_eq!(
            resolve_vault(&t.path().join("cfg"), None, &default),
            Resolution::Root(default, Source::AdoptedDefault)
        );
    }

    /// Two top-level notes is the threshold a pick has to clear, for a real
    /// pre-marker vault chosen by hand.
    #[test]
    fn a_picked_pre_marker_vault_with_two_notes_is_adopted_as_is() {
        let t = TempDir::new().unwrap();
        let v = t.path().join("Old Vault");
        fs::create_dir_all(&v).unwrap();
        fs::write(v.join("Welcome.md"), "a").unwrap();
        fs::write(v.join("Ideas.md"), "b").unwrap();

        assert!(looks_like_vault_at(&v, Confidence::Picked));
        assert!(inspect(&v).is_vault);
        // adopted, not seeded, and the marker is backfilled
        assert_eq!(open_or_init(&v, false), Ok(false));
        assert!(v.join(VAULT_MARKER).is_dir());
    }

    /// The marker is conclusive at both levels, whatever else is in there.
    #[test]
    fn the_marker_alone_satisfies_a_pick() {
        let t = TempDir::new().unwrap();
        let v = vault_at(t.path());
        assert!(looks_like_vault_at(&v, Confidence::Picked));
        assert!(looks_like_vault_at(&v, Confidence::Adopting));
    }

    #[test]
    fn inspect_reports_the_three_states() {
        let t = TempDir::new().unwrap();
        let v = vault_at(t.path());
        let i = inspect(&v);
        assert!(i.exists && i.is_vault);

        let d = t.path().join("Docs");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.txt"), "x").unwrap();
        let i = inspect(&d);
        assert!(i.exists && !i.is_vault && !i.empty);

        let i = inspect(&t.path().join("nope"));
        assert!(!i.exists && !i.is_vault && i.empty);
    }

    /// Both of these earn the "Open vault" verb, but only one of
    /// them has been a Substrate vault before. The picker's disclosure line
    /// ("Substrate will add its own files here…") is true for the folder of
    /// loose notes and false for the returning vault, so `inspect` has to say
    /// which is which rather than leaving the UI to guess from `is_vault`.
    #[test]
    fn the_marker_separates_a_returning_vault_from_a_folder_of_loose_notes() {
        let t = TempDir::new().unwrap();

        let returning = vault_at(t.path());
        let i = inspect(&returning);
        assert!(i.is_vault && i.has_marker, "a `.vault/` folder is a returning vault: {i:?}");

        let loose = t.path().join("Notes");
        fs::create_dir_all(&loose).unwrap();
        fs::write(loose.join("a.md"), "# a").unwrap();
        fs::write(loose.join("b.md"), "# b").unwrap();
        let i = inspect(&loose);
        assert!(i.is_vault, "two top-level notes still open without consent: {i:?}");
        assert!(!i.has_marker, "…but nothing of Substrate's is on disk yet: {i:?}");

        // and a folder that is not a vault at all never claims the marker
        let other = t.path().join("Docs2");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("a.txt"), "x").unwrap();
        assert!(!inspect(&other).has_marker);
    }

    /// A folder-organised Obsidian vault — every note in a
    /// subfolder, nothing loose at the root — still needs consent (the
    /// invariant is untouched), but `inspect` now says WHY it looks
    /// note-ish so the UI can pick the friendlier wording.
    #[test]
    fn a_folder_organised_vault_is_flagged_as_nested_markdown_but_still_needs_consent() {
        let t = TempDir::new().unwrap();
        let v = t.path().join("Obsidian");
        fs::create_dir_all(v.join("Daily")).unwrap();
        fs::create_dir_all(v.join("Projects")).unwrap();
        fs::write(v.join("Daily/2026-08-04.md"), "today").unwrap();
        fs::write(v.join("Projects/Album.md"), "notes").unwrap();

        let i = inspect(&v);
        assert!(i.exists && !i.is_vault && !i.empty, "the guard still holds: {i:?}");
        assert!(i.nested_markdown, "notes in subfolders must be visible to the UI: {i:?}");
        // and nothing is written without consent
        assert!(open_or_init(&v, false).is_err());
        assert!(!v.join(VAULT_MARKER).exists(), "refusal must not write anything");
    }

    /// The flag is about SUBfolders, not the root: a checkout with one stray
    /// `README.md` and no markdown below it keeps the plain warning.
    #[test]
    fn a_checkout_with_only_a_top_level_readme_is_not_nested_markdown() {
        let t = TempDir::new().unwrap();
        let repo = t.path().join("checkout");
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("README.md"), "# project").unwrap();
        fs::write(repo.join("src/main.rs"), "fn main() {}").unwrap();

        assert!(!inspect(&repo).nested_markdown);
    }

    /// Hidden folders never count — a `.git/` or `.obsidian/` full of
    /// markdown says nothing about the user's notes.
    #[test]
    fn hidden_folders_do_not_count_as_nested_markdown() {
        let t = TempDir::new().unwrap();
        let repo = t.path().join("hidden-md");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join(".git/COMMIT_EDITMSG.md"), "x").unwrap();
        fs::write(repo.join("code.rs"), "fn main() {}").unwrap();

        assert!(!inspect(&repo).nested_markdown);
    }
}
