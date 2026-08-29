//! The Drive Shelf: what is plugged in, what was ever plugged in, and what
//! was on it.
//!
//! A drive is a mount (see `commands::mounts`) the app made for an external
//! volume, so it has the same two halves: the catalog and the volume's
//! identity are in the vault and sync, while the path it is mounted at right
//! now is this machine's business and lives in `appcfg`. The commands here
//! are the ones a shelf needs on top of that — noticing a disk appear,
//! reading a catalog with the disk gone, and being told to stop.

use crate::vault::{DriveEntry, DriveHit, DriveInfo, ExtractQueue, Volume};
use crate::{appcfg, blocking, AppState, OnboardingState, SnapDirty};
use tauri::{Emitter, Manager, State};

fn bindings(cfg_dir: &std::path::Path) -> std::collections::BTreeMap<String, std::path::PathBuf> {
    appcfg::read_config(cfg_dir).mounts
}

/// The shelf: every drive this vault knows, online first.
#[tauri::command]
pub(crate) fn drives_list(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
) -> Vec<DriveInfo> {
    let binds = bindings(&onboarding.config_dir);
    state.0.lock().unwrap().drives(&binds)
}

/// One level of a drive's catalog. Reads the index, never the disk, so it
/// answers the same whether the drive is on the desk or in a drawer.
#[tauri::command]
pub(crate) fn drive_entries(state: State<AppState>, id: String, prefix: String) -> Vec<DriveEntry> {
    state.0.lock().unwrap().drive_entries(&id, &prefix)
}

/// "Which disk is this file on?" — across every catalog, including drives
/// nothing has seen in a year. Each hit carries its catalog's age.
#[tauri::command]
pub(crate) fn drive_search(
    state: State<AppState>,
    onboarding: State<OnboardingState>,
    query: String,
) -> Vec<DriveHit> {
    let binds = bindings(&onboarding.config_dir);
    state.0.lock().unwrap().search_drives(&query, &binds)
}

/// Notice what is plugged in, and act on the difference.
///
/// Three things happen here and nowhere else:
///
/// * a volume that is present and not ignored is adopted (its catalog found
///   or started), bound to where it is mounted right now, and scanned;
/// * a drive whose volume is no longer present is unbound on this machine —
///   the catalog stays, which is the entire point of the shelf;
/// * nothing is ever written to the volume itself.
///
/// Runs on a timer and on the shelf's own refresh. Slow (a scan walks a
/// disk), hence `blocking`.
#[tauri::command]
pub(crate) async fn drives_sync(app: tauri::AppHandle) -> Result<Vec<DriveInfo>, String> {
    blocking(move || {
        let onboarding: State<OnboardingState> = app.state();
        let cfg_dir = onboarding.config_dir.clone();
        let volumes = crate::vault::volumes_at(&crate::vault::volume_search_roots());
        sync_volumes(&app, &cfg_dir, &volumes)
    })
    .await?
}

/// The body of [`drives_sync`] with the volume list handed in — the seam the
/// tests drive, and what the boot poller calls.
pub(crate) fn sync_volumes(
    app: &tauri::AppHandle,
    cfg_dir: &std::path::Path,
    volumes: &[Volume],
) -> Result<Vec<DriveInfo>, String> {
    let state: State<AppState> = app.state();
    let ignored = appcfg::read_config(cfg_dir).drives_ignored;
    let plan = {
        let engine = state.0.lock().unwrap();
        engine.drive_sync_plan(volumes, &bindings(cfg_dir), &ignored)
    };
    let mut changed = false;
    let mut jobs = Vec::new();
    // One disk that refuses to be cataloged must not cost the others their
    // sync: each volume is adopted on its own, and its failure is collected
    // rather than thrown. The failures ARE returned at the end, because that
    // is what makes the poller try again (see `seen` in `lib.rs`) instead of
    // waiting for the volume set to change.
    let mut failed: Vec<String> = Vec::new();

    for vol in plan.adopt.iter().filter_map(|i| volumes.get(*i)) {
        let adopted = state
            .0
            .lock()
            .unwrap()
            .adopt_volume(vol)
            // the binding is written before the scan for the same reason
            // `mount_add` does it: a scan that runs against a path this
            // machine has not recorded leaves an index nothing can be
            // located from
            .and_then(|id| appcfg::write_mount_binding(cfg_dir, &id, Some(&vol.root)).map(|_| id));
        let id = match adopted {
            Ok(id) => id,
            Err(e) => {
                failed.push(format!("{}: {e}", vol.label));
                continue;
            }
        };
        // The catalog walk is the long pole — minutes on a multi-terabyte
        // disk — and the engine is the one mutex every window command queues
        // behind, so a scan that held it throughout froze the window for the
        // duration. It is three steps here: read what the walk needs under
        // the lock, walk the disk with the lock RELEASED, take it back for
        // the catalog write, which is vault-sized.
        //
        // The plan is bound in a statement of its OWN. Chained onto the walk
        // it would read as three steps and behave as one: the guard is a
        // temporary that lives to the end of the statement it appears in, so
        // the walk would run with the lock still held.
        let plan = state.0.lock().unwrap().scan_plan(&id, &vol.root);
        let walk = plan.walk();
        let mut engine = state.0.lock().unwrap();
        // where this mount points now, not where it pointed when we planned:
        // the disk can be rebound while its own walk runs
        let stats = engine.scan_commit(walk, bindings(cfg_dir).get(&id).map(|p| p.as_path()));
        match &stats.error {
            None => jobs.extend(engine.mount_extract_jobs(&id, &vol.root)),
            Some(e) => failed.push(format!("{}: {e}", vol.label)),
        }
        changed = true;
    }

    // Gone: unbind here, keep everything the vault knows — that a disk is in
    // a drawer is the state the shelf exists to render, not a state to clean
    // up after.
    for id in &plan.unbind {
        appcfg::write_mount_binding(cfg_dir, id, None)?;
        // this machine's extracted document text describes files it can no
        // longer open, exactly as an explicit unbind does
        state.0.lock().unwrap().forget_mount_text(id);
        changed = true;
    }

    if !jobs.is_empty() {
        app.state::<ExtractQueue>().enqueue(jobs);
    }
    if changed {
        app.state::<SnapDirty>().mark();
        app.emit("vault:changed", Vec::<String>::new()).ok();
    }
    if !failed.is_empty() {
        return Err(format!("could not catalog {}", failed.join("; ")));
    }
    let binds = bindings(cfg_dir);
    let shelf = state.0.lock().unwrap().drives(&binds);
    Ok(shelf)
}

/// "Forget this drive": drop the catalog and stop cataloging the disk on this
/// machine. The disk itself is never touched — forgetting a drive is a
/// statement about this vault, not about the volume.
///
/// `cleanup` follows `mount_remove`: false keeps every sidecar note that was
/// written about a file on the disk, true trashes them (recoverable).
#[tauri::command]
pub(crate) fn drive_forget(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    onboarding: State<OnboardingState>,
    id: String,
    cleanup: bool,
) -> Result<Vec<DriveInfo>, String> {
    dirty.mark();
    let cfg_dir = &onboarding.config_dir;
    let mut engine = state.0.lock().unwrap();
    let volume = engine
        .mounts()
        .into_iter()
        .find(|m| m.id == id)
        .and_then(|m| m.volume)
        .ok_or_else(|| format!("no such drive: {id}"))?;
    engine.remove_mount(&id, cleanup)?;
    drop(engine);
    appcfg::write_mount_binding(cfg_dir, &id, None)?;
    // without this the next poll would re-adopt the disk it was just told to
    // forget, which is the one way "Forget" could read as broken
    appcfg::write_drive_ignored(cfg_dir, &volume.id, true)?;
    let binds = bindings(cfg_dir);
    let shelf = state.0.lock().unwrap().drives(&binds);
    Ok(shelf)
}

/// Undo a forget: catalog this volume again the next time it is seen.
#[tauri::command]
pub(crate) fn drive_unforget(
    onboarding: State<OnboardingState>,
    volume: String,
) -> Result<(), String> {
    appcfg::write_drive_ignored(&onboarding.config_dir, &volume, false)
}

/// Volume ids this machine has been told not to catalog — what the shelf
/// shows behind "Ignored drives", so a forget is visible and reversible
/// rather than a disk that mysteriously never appears.
#[tauri::command]
pub(crate) fn drives_ignored(onboarding: State<OnboardingState>) -> Vec<String> {
    appcfg::read_config(&onboarding.config_dir).drives_ignored.into_iter().collect()
}
