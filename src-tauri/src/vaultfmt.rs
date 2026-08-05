//! Format versions for the hidden `.vault/*.json` config files (SUB-433).
//!
//! Two app versions can share one vault — phone⇄Mac sync, a laptop that
//! hasn't updated, a restored backup. Until now nothing on disk said which
//! app wrote a config file, so an older app silently rewrote a newer one and
//! dropped whatever keys it didn't understand (vault-format.md §7).
//!
//! ## Why a sidecar instead of a key inside each file
//!
//! The obvious design — a `"$format": 1` key inside schema.json and friends —
//! is the one thing we must not do. Every already-shipped Substrate parses
//! `schema.json` as `HashMap<String, TypeSchema>`, so an unexpected top-level
//! number makes the WHOLE file fail to parse and read as an empty schema; and
//! `folders.json` is a JSON array, which has nowhere to put a top-level key at
//! all. Stamping the version inline would cause exactly the silent data loss
//! this exists to prevent, on the older app we're trying to protect.
//!
//! So the version lives beside the data, in one sidecar the app owns:
//!
//! ```json
//! // .vault/format.json
//! { "schema": 1, "views": 1, "folders": 1, "notifications": 1, "calendars": 1, "tagfolders": 1, "mounts": 1 }
//! ```
//!
//! An older app doesn't know the sidecar exists and ignores it — its config
//! files stay byte-shaped exactly as before. A missing sidecar, or a missing
//! entry in it, reads as version 1: the current format, which is what every
//! existing vault is already in. No migration, no touched bytes on upgrade.
//!
//! ## The two rules riding on that number
//!
//! * **Refuse newer.** If a file's recorded version is above what this app
//!   knows, the app treats that file as read-only: reads still work (the app
//!   keeps running normally), the write path errors with a plain "update the
//!   app" message through the caller's existing error surface. Only the one
//!   newer file is refused — the rest of the vault is unaffected.
//! * **Migrate older.** Per-file chains of pure `v_n → v_n+1` transforms run
//!   against the parsed JSON before a write, with the prior file copied to
//!   `.vault/backup/<name>.v<N>.json` first. There is only v1 today, so every
//!   chain is empty — what ships here is the rails, not speculative
//!   migrations.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// The version sidecar, relative to the vault root.
pub const FORMAT_REL_PATH: &str = ".vault/format.json";

/// Where pre-migration backups land, relative to the vault root.
pub const BACKUP_REL_DIR: &str = ".vault/backup";

/// The hidden config files that carry a format version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VaultFile {
    Schema,
    Views,
    Folders,
    Notifications,
    Calendars,
    TagFolders,
    Mounts,
}

impl VaultFile {
    pub const ALL: [VaultFile; 7] = [
        VaultFile::Schema,
        VaultFile::Views,
        VaultFile::Folders,
        VaultFile::Notifications,
        VaultFile::Calendars,
        VaultFile::TagFolders,
        VaultFile::Mounts,
    ];

    /// This file's key in the sidecar.
    pub fn key(self) -> &'static str {
        match self {
            VaultFile::Schema => "schema",
            VaultFile::Views => "views",
            VaultFile::Folders => "folders",
            VaultFile::Notifications => "notifications",
            VaultFile::Calendars => "calendars",
            VaultFile::TagFolders => "tagfolders",
            VaultFile::Mounts => "mounts",
        }
    }

    pub fn rel_path(self) -> &'static str {
        match self {
            VaultFile::Schema => crate::vault::SCHEMA_REL_PATH,
            VaultFile::Views => crate::vault::ViewPref::REL_PATH,
            VaultFile::Folders => crate::vault::FOLDERS_REL_PATH,
            VaultFile::Notifications => crate::notify::STATE_REL_PATH,
            VaultFile::Calendars => crate::calendarfeed::CONFIG_REL_PATH,
            VaultFile::TagFolders => crate::vault::TagFolder::REL_PATH,
            VaultFile::Mounts => crate::vault::MOUNTS_REL_PATH,
        }
    }

    /// The highest version of this file the app knows how to write.
    pub fn current(self) -> u32 {
        match self {
            VaultFile::Schema => 1,
            VaultFile::Views => 1,
            VaultFile::Folders => 1,
            VaultFile::Notifications => 1,
            VaultFile::Calendars => 1,
            VaultFile::TagFolders => 1,
            VaultFile::Mounts => 1,
        }
    }

    /// What the user loses access to while the file is refused — phrased to
    /// finish "update the app to edit …".
    pub fn label(self) -> &'static str {
        match self {
            VaultFile::Schema => "database schemas",
            VaultFile::Views => "layout preferences",
            VaultFile::Folders => "folder databases",
            VaultFile::Notifications => "notification state",
            VaultFile::Calendars => "calendar subscriptions",
            VaultFile::TagFolders => "tag folders",
            // one version covers the registry and the per-mount index files
            // it owns under `.vault/mounts/` — those are derived caches,
            // rewritten wholesale, never migrated independently
            VaultFile::Mounts => "mounted folders",
        }
    }

    /// What the file's reader does with bytes that don't parse. `true` =
    /// reads as empty (vault-format §6–§8b); `false` = refuses loudly, the
    /// way `calendarfeed::read_config` surfaces a config error (§5c). The
    /// doctor's `corrupt-config` detail derives its consequence clause from
    /// this, so the text can never claim a fallback a reader doesn't have.
    /// Deliberately exhaustive — a new file must state its contract here.
    pub fn reads_empty_on_corrupt(self) -> bool {
        match self {
            VaultFile::Schema => true,
            VaultFile::Views => true,
            VaultFile::Folders => true,
            VaultFile::Notifications => true,
            VaultFile::Calendars => false,
            VaultFile::TagFolders => true,
            VaultFile::Mounts => true,
        }
    }

    /// `.vault/backup/<name>.v<N>.json` — where the pre-migration copy goes.
    /// Overwrite-safe by design: one slot per file per source version.
    pub fn backup_path(self, root: &Path, version: u32) -> PathBuf {
        root.join(BACKUP_REL_DIR).join(format!("{}.v{version}.json", self.key()))
    }

    /// The chain of pure transforms for this file: entry `i` migrates version
    /// `i + 1` to `i + 2`. Empty while v1 is the only version.
    pub fn chain(self) -> &'static [Migration] {
        match self {
            VaultFile::Schema => &[],
            VaultFile::Views => &[],
            VaultFile::Folders => &[],
            VaultFile::Notifications => &[],
            VaultFile::Calendars => &[],
            VaultFile::TagFolders => &[],
            VaultFile::Mounts => &[],
        }
    }
}

/// One version step. Pure: it rewrites the parsed JSON in place and touches
/// no disk. Recording the new version is the framework's job, not a step's.
pub type Migration = fn(&mut Value) -> Result<(), String>;

/// The whole sidecar, parsed. A missing, unreadable, or corrupt sidecar reads
/// as empty — every file then reads as v1, which is what an untouched vault
/// already is. Corrupt must never lock the user out of writing.
pub fn read_sidecar(root: &Path) -> Map<String, Value> {
    let Ok(raw) = std::fs::read_to_string(root.join(FORMAT_REL_PATH)) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// The version recorded for one file. Anything that isn't a positive integer
/// — absent, null, a string, a hand-typed `0` — reads as v1.
pub fn version_of(sidecar: &Map<String, Value>, file: VaultFile) -> u32 {
    sidecar
        .get(file.key())
        .and_then(Value::as_u64)
        .filter(|v| *v >= 1)
        .map(|v| v.min(u32::MAX as u64) as u32)
        .unwrap_or(1)
}

/// The version recorded on disk for one file.
pub fn on_disk_version(root: &Path, file: VaultFile) -> u32 {
    version_of(&read_sidecar(root), file)
}

/// Record `version` for `file`, leaving every other entry (including ones
/// this app doesn't know) untouched. No-op when the sidecar already says so,
/// so a normal config write doesn't churn a second file.
pub fn record_version(root: &Path, file: VaultFile, version: u32) -> Result<(), String> {
    let mut sidecar = read_sidecar(root);
    if sidecar.get(file.key()).and_then(Value::as_u64) == Some(version as u64) {
        return Ok(());
    }
    sidecar.insert(file.key().to_string(), Value::from(version));
    let abs = root.join(FORMAT_REL_PATH);
    if let Some(dir) = abs.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&Value::Object(sidecar)).map_err(|e| e.to_string())?;
    crate::vault::write_atomic(&abs, json)
}

/// The refuse-newer message. Deliberately undramatic: nothing is broken and
/// nothing was lost — this app is just too old to safely rewrite this file.
pub fn newer_message(file: VaultFile, found: u32) -> String {
    format!(
        "This vault was written by a newer Substrate (config format v{found}; this app writes v{}) — update the app to edit {}. Everything else keeps working.",
        file.current(),
        file.label()
    )
}

/// True when any versioned config file records a version this app can't
/// write — i.e. a newer Substrate has written this vault.
///
/// The per-file `prepare_write` guard is the right gate for the versioned
/// files themselves. This vault-level read exists for boot-time writes to
/// UNversioned files (the `AGENTS.md` and `Settings.md` backfills): there is
/// no sidecar entry to consult for those, so the conservative reading is "a
/// newer app owns this vault, don't add files to it behind its back."
///
/// Both targets, deliberately (SUB-1110): it was `#[cfg(desktop)]` while its
/// only caller was the desktop-only boot backfill, but the post-pull backfill
/// in `gitsync` runs on the phone too and asks the same question about the same
/// unversioned files. The question itself has nothing target-specific in it —
/// it reads the sidecar and compares numbers — and answering it only on desktop
/// would mean the phone is the device that writes behind a newer app's back.
pub fn vault_written_by_newer_app(root: &Path) -> bool {
    let sidecar = read_sidecar(root);
    VaultFile::ALL.iter().any(|f| version_of(&sidecar, *f) > f.current())
}

/// Gate every write to a versioned config file. Call this BEFORE writing.
///
/// Refuses when the recorded version is newer than this app knows; otherwise
/// migrates the file up to current (backing up the prior file first) and
/// records the current version. Returns the version step taken, if any.
pub fn prepare_write(root: &Path, file: VaultFile) -> Result<Option<(u32, u32)>, String> {
    let found = on_disk_version(root, file);
    if found > file.current() {
        return Err(newer_message(file, found));
    }
    let stepped = migrate_file(root, file, file.chain())?;
    // stamp even when nothing migrated: this write is what makes the file
    // current-format, and an unstamped v1 file is indistinguishable anyway
    record_version(root, file, file.current())?;
    Ok(stepped)
}

/// Run `chain` over the file on disk, backing the prior file up to
/// `.vault/backup/<name>.v<N>.json` before the migrated shape lands. No-ops
/// when the file is missing, corrupt, or already current.
///
/// `chain` is a parameter rather than read off `file` so the rails stay
/// exercisable while every real chain is still empty.
pub fn migrate_file(
    root: &Path,
    file: VaultFile,
    chain: &[Migration],
) -> Result<Option<(u32, u32)>, String> {
    migrate_file_to(root, file, file.current(), chain)
}

/// `migrate_file` with the target version as a parameter. Only tests pass
/// anything but `file.current()` — it exists so the disk rails (chain order,
/// backup, rewrite, recorded version) are testable at v1.
pub fn migrate_file_to(
    root: &Path,
    file: VaultFile,
    target: u32,
    chain: &[Migration],
) -> Result<Option<(u32, u32)>, String> {
    let abs = root.join(file.rel_path());
    let from = on_disk_version(root, file);
    if from >= target {
        return Ok(None);
    }
    let Ok(raw) = std::fs::read_to_string(&abs) else {
        // nothing on disk to migrate; the write about to happen is current
        return Ok(None);
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(None); // corrupt reads as empty everywhere else too
    };
    let to = migrate_value_to(file, from, target, &mut value, chain)?;
    if to == from {
        return Ok(None);
    }
    // the prior file is preserved before the migrated shape replaces it
    let backup = file.backup_path(root, from);
    if let Some(dir) = backup.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::vault::write_atomic(&backup, raw)?;
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    crate::vault::write_atomic(&abs, json)?;
    record_version(root, file, to)?;
    Ok(Some((from, to)))
}

/// Walk `value` from `from` up to `target` through `chain`. Pure — no disk.
/// Errors if the chain can't reach the target, which would mean a missing
/// step in this build, not trouble with the user's data.
pub fn migrate_value_to(
    file: VaultFile,
    from: u32,
    target: u32,
    value: &mut Value,
    chain: &[Migration],
) -> Result<u32, String> {
    if from > target {
        return Err(newer_message(file, from));
    }
    let mut at = from;
    while at < target {
        let step = chain.get((at - 1) as usize).ok_or_else(|| {
            format!(
                "no migration from config format v{at} to v{} for {} — this app can't upgrade the file",
                at + 1,
                file.rel_path()
            )
        })?;
        step(value)?;
        at += 1;
    }
    Ok(at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vault-fmt-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".vault")).unwrap();
        dir
    }

    #[test]
    fn no_sidecar_reads_as_v1() {
        // every pre-SUB-433 vault: no sidecar at all, everything is v1
        let root = temp_root("nosidecar");
        for f in VaultFile::ALL {
            assert_eq!(on_disk_version(&root, f), 1, "{}", f.key());
        }
        // junk in the slot is not a version either — never lock a user out
        let junk: Map<String, Value> = serde_json::from_value(json!({
            "views": "two", "schema": 0, "folders": -3, "notifications": 7, "mounts": 1.5
        }))
        .unwrap();
        assert_eq!(version_of(&junk, VaultFile::Views), 1);
        assert_eq!(version_of(&junk, VaultFile::Schema), 1);
        assert_eq!(version_of(&junk, VaultFile::Folders), 1);
        assert_eq!(version_of(&junk, VaultFile::Notifications), 7);
        assert_eq!(version_of(&junk, VaultFile::Calendars), 1);
        assert_eq!(version_of(&junk, VaultFile::Mounts), 1, "a non-integer is not a version");
    }

    #[test]
    fn corrupt_sidecar_reads_as_v1_and_still_writes() {
        let root = temp_root("corruptside");
        std::fs::write(root.join(FORMAT_REL_PATH), "not json {{").unwrap();
        assert_eq!(on_disk_version(&root, VaultFile::Views), 1);
        assert!(prepare_write(&root, VaultFile::Views).is_ok());
    }

    #[test]
    fn newer_file_refuses_write_and_names_the_thing() {
        let root = temp_root("newer");
        std::fs::write(root.join(FORMAT_REL_PATH), r#"{"schema": 9}"#).unwrap();
        let err = prepare_write(&root, VaultFile::Schema).unwrap_err();
        assert!(err.contains("newer Substrate"), "{err}");
        assert!(err.contains("v9"), "names the version found: {err}");
        assert!(err.contains("database schemas"), "names what's locked: {err}");
        // one newer file doesn't lock the rest of the vault
        assert!(prepare_write(&root, VaultFile::Views).is_ok());
        // and the refusal didn't clobber the newer app's entry
        assert_eq!(on_disk_version(&root, VaultFile::Schema), 9);
    }

    #[test]
    fn recording_a_version_preserves_unknown_sidecar_entries() {
        let root = temp_root("sidecarkeys");
        std::fs::write(root.join(FORMAT_REL_PATH), r#"{"views": 1, "somethingNew": 4}"#).unwrap();
        record_version(&root, VaultFile::Schema, 1).unwrap();
        let after = read_sidecar(&root);
        assert_eq!(after["somethingNew"], json!(4), "a newer app's entry survives");
        assert_eq!(after["schema"], json!(1));
        assert_eq!(after["views"], json!(1));
    }

    /// A stand-in two-step chain: v1 → v2 → v3, the second proving order.
    fn demo_chain() -> [Migration; 2] {
        fn to_v2(v: &mut Value) -> Result<(), String> {
            v.as_object_mut().ok_or("not an object")?.insert("two".into(), json!(true));
            Ok(())
        }
        fn to_v3(v: &mut Value) -> Result<(), String> {
            let m = v.as_object_mut().ok_or("not an object")?;
            let saw_v2 = m.contains_key("two"); // v3's step sees v2's work
            m.insert("three".into(), json!(saw_v2));
            Ok(())
        }
        [to_v2, to_v3]
    }

    #[test]
    fn migration_chain_runs_in_order() {
        let mut value = json!({"kept": 1});
        let at = migrate_value_to(VaultFile::Views, 1, 3, &mut value, &demo_chain()).unwrap();
        assert_eq!(at, 3);
        assert_eq!(value["kept"], json!(1), "untouched keys survive the chain");
        assert_eq!(value["two"], json!(true), "v1→v2 ran");
        assert_eq!(value["three"], json!(true), "v2→v3 ran, and after v1→v2");
    }

    #[test]
    fn migrate_file_backs_up_the_prior_file_then_rewrites() {
        let root = temp_root("migrate");
        let path = root.join(VaultFile::Views.rel_path());
        let prior = r#"{"release": {"view": "board"}}"#; // no sidecar entry = v1
        std::fs::write(&path, prior).unwrap();

        let step = migrate_file_to(&root, VaultFile::Views, 3, &demo_chain()).unwrap();
        assert_eq!(step, Some((1, 3)), "reported the version step it took");

        let backup = VaultFile::Views.backup_path(&root, 1);
        assert!(backup.ends_with(".vault/backup/views.v1.json"), "{backup:?}");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            prior,
            "backup holds the pre-migration bytes verbatim"
        );

        let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["release"]["view"], json!("board"), "real config survived");
        assert_eq!(after["two"], json!(true));
        assert_eq!(on_disk_version(&root, VaultFile::Views), 3, "new version recorded");

        // rerunning is a no-op now that the sidecar says v3
        assert_eq!(migrate_file_to(&root, VaultFile::Views, 3, &demo_chain()).unwrap(), None);
    }

    #[test]
    fn migrate_is_a_noop_at_current_version() {
        let root = temp_root("noop");
        let path = root.join(VaultFile::Folders.rel_path());
        let prior = r#"[{"path": "~/x", "type": "doc"}]"#;
        std::fs::write(&path, prior).unwrap();
        assert_eq!(migrate_file(&root, VaultFile::Folders, &[]).unwrap(), None);
        assert!(!root.join(BACKUP_REL_DIR).exists(), "nothing migrated, no backup invented");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), prior, "file byte-identical");
    }

    #[test]
    fn a_failing_migration_step_leaves_the_file_alone() {
        fn boom(_: &mut Value) -> Result<(), String> {
            Err("nope".into())
        }
        let root = temp_root("failstep");
        let path = root.join(VaultFile::Schema.rel_path());
        let prior = r#"{"release": {}}"#;
        std::fs::write(&path, prior).unwrap();
        assert!(migrate_file_to(&root, VaultFile::Schema, 2, &[boom as Migration]).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            prior,
            "on-disk file untouched when a step fails"
        );
        assert!(!root.join(BACKUP_REL_DIR).exists(), "no backup before the transform succeeds");
        assert_eq!(on_disk_version(&root, VaultFile::Schema), 1, "version not advanced");
    }

    #[test]
    fn missing_step_errors_rather_than_writing_a_half_migrated_file() {
        let mut value = json!({});
        assert_eq!(
            migrate_value_to(VaultFile::Views, 1, 1, &mut value, &[]).unwrap(),
            1,
            "v1 file, v1 app — no steps needed"
        );
        let err = migrate_value_to(VaultFile::Views, 1, 2, &mut value, &[]).unwrap_err();
        assert!(err.contains("no migration"), "{err}");
        // a newer file refuses rather than silently downgrading
        assert!(migrate_value_to(VaultFile::Views, 4, 1, &mut value, &[]).is_err());
    }

    #[test]
    fn every_file_has_a_distinct_key_path_and_backup_slot() {
        let root = PathBuf::from("/tmp/x");
        let mut keys = std::collections::HashSet::new();
        let mut paths = std::collections::HashSet::new();
        for f in VaultFile::ALL {
            assert!(keys.insert(f.key()), "duplicate key {}", f.key());
            assert!(paths.insert(f.rel_path()), "duplicate path {}", f.rel_path());
            assert!(f.backup_path(&root, f.current()).starts_with("/tmp/x/.vault/backup"));
            assert!(!f.label().is_empty());
            assert!(f.rel_path().starts_with(".vault/"));
        }
        // the sidecar itself is not one of the versioned files
        assert!(!paths.contains(FORMAT_REL_PATH));
    }
}
