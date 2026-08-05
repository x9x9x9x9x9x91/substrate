//! Reality mounts: a real folder rendered as a database.
//!
//! A mount has two halves that live in different places on purpose. Its
//! identity — id, name, globs — is in the vault and syncs; the path it points
//! at is machine-local and lives in this machine's app config. So every
//! command here that touches a path also touches `appcfg`, and the ones that
//! only touch identity do not.

use crate::vault::{ExtractQueue, Mount, MountRow, MountScanStats};
use crate::{appcfg, blocking, AppState, OnboardingState, SnapDirty};
use tauri::{Emitter, Manager, State};

/// Hand a freshly scanned mount's unread files to the background queue.
/// Called with the engine lock already released: enqueueing is a
/// push onto a bounded deque, and everything slow happens on the queue's own
/// threads. Files past the queue's capacity are simply not taken — the next
/// scan offers them again.
fn queue_extraction(app: &tauri::AppHandle, jobs: Vec<crate::vault::ExtractJob>) {
    if !jobs.is_empty() {
        app.state::<ExtractQueue>().enqueue(jobs);
    }
}

fn bind_mount_on_machine(
    engine: &mut crate::vault::Engine,
    cfg_dir: &std::path::Path,
    id: &str,
    path: Option<&std::path::Path>,
) -> Result<MountScanStats, String> {
    // A refused folder must not replace a previously valid binding. Keep
    // validation ahead of the config write, exactly like `mount_add`.
    if let Some(path) = path {
        engine.check_mount_path(path)?;
    }
    appcfg::write_mount_binding(cfg_dir, id, path)?;
    Ok(match path {
        Some(path) => engine.scan_mount(id, path),
        None => {
            // Unbinding leaves the mount and its index alone, but this
            // machine's document text describes files it can no longer open
            // and nothing will read it again.
            engine.forget_mount_text(id);
            MountScanStats {
                id: id.to_string(),
                ..Default::default()
            }
        }
    })
}

/// One mount as the UI needs it: what the vault knows, plus whether this
/// machine can actually reach the folder. `path` absent = unbound here, which
/// is a normal state, not an error — the board still renders from the index.
#[derive(serde::Serialize)]
pub(crate) struct MountInfo {
    #[serde(flatten)]
    pub mount: Mount,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Bound here, but the folder is gone (unplugged drive, moved folder).
    pub missing: bool,
    /// When the index was last refreshed; empty for a mount never scanned.
    pub scanned: String,
    /// Rows in the last-known index — the count the database list shows.
    /// From the index, not the disk, so it is the same on every machine.
    pub files: usize,
}

fn info(state: &State<AppState>, cfg_dir: &std::path::Path) -> Vec<MountInfo> {
    let bindings = appcfg::read_config(cfg_dir).mounts;
    let engine = state.0.lock().unwrap();
    engine
        .mounts()
        .into_iter()
        .map(|mount| {
            let bound = bindings.get(&mount.id);
            let index = engine.mount_index(&mount.id);
            MountInfo {
                path: bound.map(|p| p.to_string_lossy().to_string()),
                // bindings are stored tilde-contracted, so the raw path is
                // not statable — expand it exactly like doctor does, or every
                // `~/…` mount reads as missing
                missing: bound
                    .map(|p| !crate::vault::expand_tilde(&p.to_string_lossy()).is_dir())
                    .unwrap_or(false),
                scanned: index.scanned,
                files: index.files.len(),
                mount,
            }
        })
        .collect()
}

#[tauri::command]
pub(crate) fn mounts_list(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
) -> Vec<MountInfo> {
    info(&state, &onboarding.config_dir)
}

/// "Mount a folder…": register the mount, bind it to the folder the user
/// picked on this machine, and scan it once so the board has rows
/// immediately. The scan is read-only on the mounted folder. Returns that
/// first scan's stats — the dialog reports them, and its `id` is the mount.
#[tauri::command]
pub(crate) async fn mount_add(
    app: tauri::AppHandle,
    name: String,
    path: String,
    globs: Vec<String>,
    watch: bool,
) -> Result<MountScanStats, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let onboarding: State<OnboardingState> = app.state();
        // validate the folder BEFORE anything is written: a bad path used to
        // leave a registered mount, an empty database and a binding behind,
        // with only the scan stats carrying the error
        // Keep validation, registration and the initial scan under one engine
        // lock. Otherwise the folder can change between validation and use,
        // reopening the same TOCTOU window `mount_bind` closes below.
        let mut engine = state.0.lock().unwrap();
        engine.check_mount_path(path.as_ref())?;
        let mount = engine.add_mount(&name, globs, watch)?;
        appcfg::write_mount_binding(&onboarding.config_dir, &mount.id, Some(path.as_ref()))?;
        let stats = engine.scan_mount(&mount.id, path.as_ref());
        let jobs = engine.mount_extract_jobs(&mount.id, path.as_ref());
        drop(engine);
        queue_extraction(&app, jobs);
        app.state::<SnapDirty>().mark();
        app.emit("vault:changed", Vec::<String>::new()).ok();
        Ok(stats)
    })
    .await?
}

/// "Locate folder…": point an existing mount at a folder on THIS machine and
/// refresh its index. Passing `None` unbinds it here — the mount, its index
/// and its sidecars all stay.
#[tauri::command]
pub(crate) async fn mount_bind(
    app: tauri::AppHandle,
    id: String,
    path: Option<String>,
) -> Result<MountScanStats, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let onboarding: State<OnboardingState> = app.state();
        let mut engine = state.0.lock().unwrap();
        let stats = bind_mount_on_machine(
            &mut engine,
            &onboarding.config_dir,
            &id,
            path.as_deref().map(std::path::Path::new),
        )?;
        let jobs = match path.as_deref() {
            Some(p) => engine.mount_extract_jobs(&id, std::path::Path::new(p)),
            None => Vec::new(),
        };
        drop(engine);
        queue_extraction(&app, jobs);
        app.state::<SnapDirty>().mark();
        app.emit("vault:changed", Vec::<String>::new()).ok();
        Ok(stats)
    })
    .await?
}

/// Rescan mounts bound on this machine — one when `id` is given, all of them
/// otherwise (the palette's "Rescan folders"). Unbound mounts are skipped:
/// their index stays exactly as the machine that has the folder left it.
/// async: statting a big folder tree is slow enough to freeze the UI.
#[tauri::command]
pub(crate) async fn mount_rescan(
    app: tauri::AppHandle,
    id: Option<String>,
) -> Result<Vec<MountScanStats>, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let onboarding: State<OnboardingState> = app.state();
        let mut bindings = appcfg::read_config(&onboarding.config_dir).mounts;
        if let Some(id) = &id {
            bindings.retain(|k, _| k == id);
        }
        let (stats, jobs) = {
            let mut engine = state.0.lock().unwrap();
            let stats = engine.sync_mounts(&bindings);
            let jobs = engine.extract_jobs(&bindings);
            (stats, jobs)
        };
        queue_extraction(&app, jobs);
        if stats.iter().any(|s| s.added + s.updated + s.renamed + s.missing > 0) {
            app.state::<SnapDirty>().mark();
            // a rescan touches an unbounded set of rows: empty vec = the
            // "unknown, refresh everything" contract, not "nothing changed"
            app.emit("vault:changed", Vec::<String>::new()).ok();
        }
        stats
    })
    .await
}

/// The mount's rows: its last-known index merged with the sidecar notes bound
/// to it. Renders the same whether or not the folder is on this machine.
#[tauri::command]
pub(crate) fn mount_rows(state: State<AppState>, id: String) -> Vec<MountRow> {
    state.0.lock().unwrap().mount_rows(&id)
}

/// Set one prop on one row, creating the row's sidecar note if this is its
/// first annotation. This is the only write path a mount has: rows are
/// read-only until the user says something about one.
#[tauri::command]
pub(crate) fn mount_annotate(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
    rel: String,
    prop: String,
    value: Option<serde_json::Value>,
) -> Result<crate::vault::NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().mount_annotate(&id, &rel, &prop, value)
}

/// Unmount. `cleanup` false keeps every sidecar as an ordinary note — dormant,
/// and reattached by content identity if the folder is mounted again.
/// `cleanup` true trashes them: recoverable from Trash, never hard-deleted.
/// The mounted folder itself is never touched either way.
#[tauri::command]
pub(crate) fn mount_remove(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    onboarding: State<OnboardingState>,
    id: String,
    cleanup: bool,
) -> Result<Vec<Mount>, String> {
    dirty.mark();
    let left = state.0.lock().unwrap().remove_mount(&id, cleanup)?;
    // drop this machine's binding too, or a later mount reusing the id
    // would inherit a stale path
    appcfg::write_mount_binding(&onboarding.config_dir, &id, None)?;
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Locate folder… → none" is the one unbind path in the app,
    /// and it used to leave the text store behind with nothing to read it.
    #[test]
    fn unbinding_here_takes_this_machines_text_with_it() {
        let vault = tempfile::TempDir::new().unwrap();
        let cfg = tempfile::TempDir::new().unwrap();
        let folder = tempfile::TempDir::new().unwrap();
        std::fs::write(folder.path().join("paper.txt"), b"a document").unwrap();
        let mut engine = crate::vault::Engine::new(vault.path().to_path_buf())
            .with_local_dir(cfg.path().to_path_buf());
        let mount = engine.add_mount("Papers", Vec::new(), true).unwrap();
        bind_mount_on_machine(&mut engine, cfg.path(), &mount.id, Some(folder.path())).unwrap();
        let store = cfg.path().join(crate::vault::MOUNT_TEXT_DIR).join(format!("{}.json", mount.id));
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, r#"{"version":1,"files":{}}"#).unwrap();

        bind_mount_on_machine(&mut engine, cfg.path(), &mount.id, None).unwrap();

        assert!(!store.exists(), "the text store outlived the binding");
        assert_eq!(engine.mounts().len(), 1, "unbinding removed the mount itself");
        assert_eq!(
            appcfg::read_config(cfg.path()).mounts.get(&mount.id),
            None,
            "the binding is gone from this machine's config"
        );
    }

    #[test]
    fn refused_bind_does_not_replace_the_machine_local_path() {
        let vault = tempfile::TempDir::new().unwrap();
        let cfg = tempfile::TempDir::new().unwrap();
        let valid = tempfile::TempDir::new().unwrap();
        let mut engine = crate::vault::Engine::new(vault.path().to_path_buf());
        let mount = engine.add_mount("Pool", Vec::new(), true).unwrap();

        appcfg::write_mount_binding(cfg.path(), &mount.id, Some(valid.path())).unwrap();
        let err = bind_mount_on_machine(&mut engine, cfg.path(), &mount.id, Some(vault.path()))
            .unwrap_err();

        assert!(err.contains("vault"), "overlap is explained: {err}");
        assert_eq!(
            appcfg::read_config(cfg.path()).mounts.get(&mount.id),
            Some(&valid.path().to_path_buf()),
            "a refused locate leaves the previous binding untouched"
        );
    }
}
