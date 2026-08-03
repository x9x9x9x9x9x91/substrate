//! Version history: the git-backed snapshot panel (list, diff, restore) plus
//! the purge/trim commands that rewrite it.

use crate::history::{DiffLine, History, HistoryEntry};
use crate::vault::{Engine, NoteMeta};
use crate::{blocking, AppState, HistoryState, SnapDirty};
use std::sync::Mutex;
use tauri::{Manager, State};

pub(crate) fn with_history<T>(
    h: &State<HistoryState>,
    f: impl FnOnce(&History) -> Result<T, String>,
) -> Result<T, String> {
    match h.0.lock().unwrap().as_ref() {
        Some(hist) => f(hist),
        None => Err("version history unavailable — git could not be initialized".into()),
    }
}

/// Run a HISTORY-REWRITING op under both gates: the history mutex AND the
/// engine mutex (SUB-661).
///
/// LOCK ORDER — history first, then the engine. Every site that holds both
/// takes them in that order (`history_restore` above does the same), so the
/// nesting can never invert into an ABBA deadlock. `vault_sync_pull` and
/// `vault_sync_resolve_finish` take the history lock first too and keep it
/// while taking the engine lock for their destructive local phase (SUB-731).
///
/// Why the engine lock at all, when a rewrite touches only git: a purge/trim
/// ends in `finish_rewrite` — `git reset` onto the rewritten tip plus
/// `gc --prune=now`. A pull's local phase computes its merge from the branch
/// tip it read BEFORE the rewrite and then sets the branch unconditionally, so
/// a pull running concurrently with a purge silently restored the history the
/// user had just destroyed forever (and the `gc` raced the merge's in-flight
/// objects). The engine mutex is the gate a pull's local phase already holds,
/// so taking it here makes rewrite and pull/resolve mutually exclusive.
fn with_history_rewrite<T>(
    h: &Mutex<Option<History>>,
    engine: &Mutex<Engine>,
    f: impl FnOnce(&History) -> Result<T, String>,
) -> Result<T, String> {
    let hist = h.lock().unwrap();
    let Some(hist) = hist.as_ref() else {
        return Err("version history unavailable — git could not be initialized".into());
    };
    let _engine = engine.lock().unwrap();
    f(hist)
}

/// What the panel needs before rendering: git up at all, and — when the
/// vault turns out to be the USER's own repo — whether history is enabled.
#[derive(serde::Serialize)]
pub(crate) struct HistoryStatus {
    available: bool,
    enabled: bool,
}

#[tauri::command]
pub(crate) fn history_status(h: State<HistoryState>) -> HistoryStatus {
    match h.0.lock().unwrap().as_ref() {
        Some(hist) => HistoryStatus { available: true, enabled: hist.is_enabled() },
        None => HistoryStatus { available: false, enabled: false },
    }
}

// async so a slow git log (large history, cold cache) can't freeze the UI.
// The state is fetched INSIDE the blocking closure: a std MutexGuard is not
// Send, so it must never be held across an await.
#[tauri::command]
pub(crate) async fn history_list(app: tauri::AppHandle, path: String) -> Result<Vec<HistoryEntry>, String> {
    blocking(move || {
        let h: State<HistoryState> = app.state();
        with_history(&h, |hist| hist.list(&path))
    })
    .await?
}

#[tauri::command]
pub(crate) fn history_diff(h: State<HistoryState>, id: String, file: String) -> Result<Vec<DiffLine>, String> {
    with_history(&h, |hist| hist.diff(&id, &file))
}

/// What a restore replaced, beyond the note itself: `overwrote_external` is
/// true when the file on disk had been changed since the baseline the UI was
/// showing — the restore still went through (that is what the user asked for),
/// but the edit it buried is only findable in history unless we say so.
#[derive(Debug)]
pub(crate) struct RestoreOutcome {
    pub meta: NoteMeta,
    pub overwrote_external: bool,
}

/// Restore = write the old version over the file, then snapshot immediately —
/// a new commit on top, never a rewrite. Split out of the command so a test
/// can drive the real sequence rather than a copy of it.
///
/// `baseline_ms` is the `updated_ms` the panel's caller was rendering. A file
/// whose on-disk mtime is NEWER than that changed under the user between the
/// panel opening and the click, and the restore is about to bury it (SUB-781).
/// It is deliberately advisory, not a guard: refusing would be a new way for a
/// restore the user explicitly asked for to fail. The toast promises the
/// buried edit is in history, so the detection has to MAKE that true: an edit
/// younger than the auto-snapshot quiet window (the panel-open-to-click race
/// this exists for) is committed nowhere until the pre-write snapshot below
/// captures it. A `baseline_ms` of 0 (caller has none) never trips it.
pub(crate) fn restore_note(
    engine: &mut Engine,
    hist: &History,
    path: &str,
    id: &str,
    file: &str,
    baseline_ms: u64,
) -> Result<RestoreOutcome, String> {
    let content = hist.show(id, file)?;
    // read before the write — afterwards the mtime is our own
    let overwrote_external = baseline_ms > 0
        && engine.disk_mtime_ms(path).is_some_and(|disk| disk > baseline_ms);
    if overwrote_external {
        hist.snapshot(&format!("external edit to {} before restore", path)).ok();
    }
    let meta = engine.write_raw(path, &content)?;
    // The file is replaced by this point, so the snapshot after it is
    // bookkeeping and must not fail the restore (SUB-548). Reporting Err here
    // put HistoryPanel on its `.catch` branch, which skips both `onRestored`
    // and `load` — the editor kept rendering the pre-restore buffer over the
    // already-restored file, and the next keystroke saved it back, undoing
    // the restore for real while the user had been told it failed. The caller
    // marks the vault dirty so the auto-snapshot loop retries.
    hist.snapshot(&format!("restore {}", path)).ok();
    Ok(RestoreOutcome { meta, overwrote_external })
}

/// Payload of `history:restored-over-external` — the front end names the note
/// in the toast, so it needs the path it just buried an edit under.
#[derive(Clone, serde::Serialize)]
pub(crate) struct RestoredOverExternal {
    pub path: String,
}

// async: a restore is three git/disk round-trips (show, write, snapshot).
#[tauri::command]
pub(crate) async fn history_restore(
    app: tauri::AppHandle,
    path: String,
    id: String,
    file: String,
    baseline_ms: Option<u64>,
) -> Result<NoteMeta, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let h: State<HistoryState> = app.state();
        let out = with_history(&h, |hist| {
            restore_note(
                &mut state.0.lock().unwrap(),
                hist,
                &path,
                &id,
                &file,
                baseline_ms.unwrap_or(0),
            )
        })?;
        app.state::<SnapDirty>().mark();
        // after the write, never instead of it: the restore succeeded and its
        // meta must reach the caller either way (SUB-781)
        if out.overwrote_external {
            use tauri::Emitter;
            app.emit("history:restored-over-external", RestoredOverExternal { path }).ok();
        }
        Ok(out.meta)
    })
    .await?
}

/// Purge notes out of all snapshots, then re-snapshot so their current state
/// becomes a fresh version 1. Split out of the two commands below so a test
/// can drive the real sequence.
pub(crate) fn purge_notes(hist: &History, rels: &[&str]) -> Result<(), String> {
    hist.purge_files(rels)?;
    // The rewrite ends in `reflog expire --expire=now` + `gc --prune=now`, so
    // by this point the old versions are unrecoverable. A failing re-snapshot
    // must not turn that into an Err (SUB-548): TrashPane deliberately chains
    // `historyPurgeNote(...).then(destroy)` so a purge failure aborts the
    // delete — correct, but it reads Err as "the purge didn't happen". An Err
    // from the snapshot AFTER a completed purge stranded the note in trash
    // with its history already destroyed, and a retry re-purged nothing.
    hist.snapshot("snapshot").ok();
    Ok(())
}

/// Permanently purge one note from all snapshots, then re-snapshot so its
/// current state becomes a fresh version 1.
#[tauri::command]
pub(crate) async fn history_purge_note(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let h: State<HistoryState> = app.state();
        with_history_rewrite(&h.0, &state.0, |hist| purge_notes(hist, &[&path]))?;
        app.state::<SnapDirty>().mark();
        Ok(())
    })
    .await?
}

/// Batch purge: all given notes out of history in ONE rewrite + one
/// re-snapshot — the engine op behind empty-trash's "also purge history".
#[tauri::command]
pub(crate) async fn history_purge_notes(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let h: State<HistoryState> = app.state();
        let rels: Vec<&str> = paths.iter().map(String::as_str).collect();
        with_history_rewrite(&h.0, &state.0, |hist| purge_notes(hist, &rels))?;
        app.state::<SnapDirty>().mark();
        Ok(())
    })
    .await?
}

/// Permanently drop all snapshots older than the given date (vault-wide).
#[tauri::command]
pub(crate) async fn history_trim(app: tauri::AppHandle, before_ms: u64) -> Result<(), String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let h: State<HistoryState> = app.state();
        with_history_rewrite(&h.0, &state.0, |hist| hist.trim_before(before_ms / 1000))
    })
    .await?
}

/// On-demand snapshot — the safety rail taken immediately before a bulk
/// rewrite (database rename/delete, property rename/strip) so the sweep is
/// one restore away from undone.
///
/// Returns whether A RESTORE POINT EXISTS, not whether a commit was made:
/// false ONLY when history is disabled (the vault is the user's own repo), so
/// the caller can warn that the sweep runs unprotected. `snapshot`'s own false
/// — a clean tree — means HEAD already IS the restore point, which is the
/// common case on a healthy vault (the auto-snapshot layer commits after a
/// couple of minutes' quiet) and must never be reported as a failure.
#[tauri::command]
pub(crate) fn history_snapshot(h: State<HistoryState>, label: String) -> Result<bool, String> {
    with_history(&h, |hist| hist.snapshot_restore_point(&label))
}

#[cfg(test)]
mod tests {
    /// SUB-729: these rewrites can take seconds or minutes, so their command
    /// handlers must stay async and yield a Send future that Tauri can drive
    /// without occupying its IPC thread.
    #[test]
    fn history_rewrite_commands_remain_async() {
        use std::future::Future;

        fn assert_one<F, Fut>(_: F)
        where
            F: Fn(tauri::AppHandle, String) -> Fut,
            Fut: Future<Output = Result<(), String>> + Send,
        {
        }

        fn assert_many<F, Fut>(_: F)
        where
            F: Fn(tauri::AppHandle, Vec<String>) -> Fut,
            Fut: Future<Output = Result<(), String>> + Send,
        {
        }

        fn assert_trim<F, Fut>(_: F)
        where
            F: Fn(tauri::AppHandle, u64) -> Fut,
            Fut: Future<Output = Result<(), String>> + Send,
        {
        }

        assert_one(super::history_purge_note);
        assert_many(super::history_purge_notes);
        assert_trim(super::history_trim);
    }

    /// SUB-548: a snapshot that fails AFTER the file has been replaced must
    /// not fail the restore. HistoryPanel's `.catch` skips `onRestored`, so
    /// the editor kept a stale buffer over an already-restored file and the
    /// next save silently undid the restore — while the user was told it
    /// failed. A blocked `git commit` is the real shape of this: the file is
    /// written, only the bookkeeping commit is refused.
    #[cfg(not(mobile))]
    #[test]
    fn a_restore_that_reached_disk_succeeds_even_if_the_snapshot_after_it_fails() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let meta = engine.create("Note", "", None).unwrap();
        let hist = crate::history::History::new(root.clone()).unwrap();
        hist.snapshot("snapshot").unwrap();
        let old = hist.list(&meta.path).unwrap()[0].clone();
        engine.write_raw(&meta.path, "changed\n").unwrap();
        hist.snapshot("snapshot").unwrap();
        block_commits(&root);

        let restored = super::restore_note(&mut engine, &hist, &meta.path, &old.id, &old.file, 0);

        assert!(restored.is_ok(), "a restore that reached disk reports success: {restored:?}");
        let on_disk = std::fs::read_to_string(root.join(&meta.path)).unwrap();
        assert!(
            !on_disk.contains("changed"),
            "and the old version really is the file: {on_disk:?}"
        );
    }

    /// SUB-781: an edit that landed on disk after the panel read the note is
    /// silently buried by a restore. The restore still runs — that is what was
    /// asked for — but it reports the bury, and the pre-write snapshot makes
    /// the toast's "in version history" promise true even when the edit is
    /// younger than the auto-snapshot quiet window (panel finding, 2026-08-02).
    #[cfg(not(mobile))]
    #[test]
    fn a_restore_reports_when_it_wrote_over_a_newer_external_edit() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let meta = engine.create("Note", "", None).unwrap();
        let hist = crate::history::History::new(root.clone()).unwrap();
        hist.snapshot("snapshot").unwrap();
        let old = hist.list(&meta.path).unwrap()[0].clone();

        // the panel's baseline: what the UI was rendering when it opened
        let baseline = engine.meta(&meta.path).unwrap().updated_ms;

        // no external edit → no report, whatever the baseline
        let quiet =
            super::restore_note(&mut engine, &hist, &meta.path, &old.id, &old.file, baseline)
                .unwrap();
        assert!(!quiet.overwrote_external, "an untouched file is not an external edit");

        // now something else writes the file, a clear tick later than the baseline
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(root.join(&meta.path), "typed elsewhere\n").unwrap();

        let loud = super::restore_note(&mut engine, &hist, &meta.path, &old.id, &old.file, baseline)
            .unwrap();
        assert!(loud.overwrote_external, "a newer on-disk file is reported, not swallowed");
        assert!(
            !std::fs::read_to_string(root.join(&meta.path)).unwrap().contains("typed elsewhere"),
            "and the restore still went through — the report is advisory, not a guard"
        );
        // the buried edit is REACHABLE in history — the pre-write snapshot
        // committed it, not just the restored content over it. Without that
        // snapshot the toast's recovery promise is false for any edit younger
        // than the auto-snapshot quiet window.
        let buried_in_history = hist.list(&meta.path).unwrap().iter().any(|e| {
            hist.show(&e.id, &e.file).is_ok_and(|body| body.contains("typed elsewhere"))
        });
        assert!(buried_in_history, "the buried edit must be recoverable from history");

        // a caller with no baseline (0) never trips it, even over the same edit
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(root.join(&meta.path), "typed again\n").unwrap();
        let unknowable =
            super::restore_note(&mut engine, &hist, &meta.path, &old.id, &old.file, 0).unwrap();
        assert!(!unknowable.overwrote_external, "no baseline means no claim either way");
    }

    /// SUB-548: the purge rewrite ends in `reflog expire --expire=now` +
    /// `gc --prune=now`, so once it returns the old versions are gone for
    /// good. TrashPane chains `historyPurgeNote(...).then(destroy)` and reads
    /// an Err as "the purge didn't happen" — an Err from the re-snapshot after
    /// a completed purge stranded the note in trash with its history already
    /// destroyed, and retrying re-purged nothing.
    #[cfg(not(mobile))]
    #[test]
    fn a_completed_purge_succeeds_even_if_the_snapshot_after_it_fails() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let meta = engine.create("Secret", "", None).unwrap();
        engine.write_raw(&meta.path, "classified\n").unwrap();
        let hist = crate::history::History::new(root.clone()).unwrap();
        hist.snapshot("snapshot").unwrap();
        block_commits(&root);

        let purged = super::purge_notes(&hist, &[&meta.path]);

        assert!(purged.is_ok(), "a completed purge reports success: {purged:?}");
        assert!(
            hist.list(&meta.path).unwrap().is_empty(),
            "and the versions really are gone, which is why the caller must be free to \
             finish deleting the note"
        );
    }

    /// SUB-661: a purge/trim rewrite must not run while a pull's local phase
    /// holds the engine gate. The pull computes its merge from the branch tip
    /// it read before the rewrite and then sets the branch unconditionally, so
    /// an overlap silently restored the history the user had just purged
    /// forever. The gate is the engine mutex — this drives the real
    /// `with_history_rewrite` against a held engine lock and proves the
    /// rewrite body cannot start until the lock is released.
    #[cfg(not(mobile))]
    #[test]
    fn a_rewrite_waits_for_the_engine_gate_a_pull_holds() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let meta = engine.create("Secret", "", None).unwrap();
        engine.write_raw(&meta.path, "classified\n").unwrap();
        let hist = Mutex::new(Some(crate::history::History::new(root.clone()).unwrap()));
        hist.lock().unwrap().as_ref().unwrap().snapshot("snapshot").unwrap();
        let engine = Arc::new(Mutex::new(engine));

        // Stand in for a pull's local phase: hold the engine gate, then drop
        // it. The barrier makes the interleaving deterministic — this thread
        // owns the lock before the rewrite below is allowed to ask for it.
        let pull_done = Arc::new(AtomicBool::new(false));
        let holding = Arc::new(std::sync::Barrier::new(2));
        let pull = {
            let (pull_done, holding, engine) =
                (Arc::clone(&pull_done), Arc::clone(&holding), Arc::clone(&engine));
            std::thread::spawn(move || {
                let guard = engine.lock().unwrap();
                holding.wait();
                std::thread::sleep(std::time::Duration::from_millis(150));
                pull_done.store(true, Ordering::SeqCst);
                drop(guard);
            })
        };
        holding.wait();

        let observed = std::sync::Mutex::new(None);
        super::with_history_rewrite(&hist, &engine, |h| {
            *observed.lock().unwrap() = Some(pull_done.load(Ordering::SeqCst));
            super::purge_notes(h, &[&meta.path])
        })
        .unwrap();
        pull.join().unwrap();

        assert!(
            observed.lock().unwrap().unwrap(),
            "the rewrite ran only after the pull's engine gate was released"
        );
        // And the purge itself still works under both locks: the old versions
        // are gone and the re-snapshot left exactly one, a fresh version 1.
        assert_eq!(hist.lock().unwrap().as_ref().unwrap().list(&meta.path).unwrap().len(), 1);
    }

    /// A `pre-commit` hook that refuses makes `git commit` fail while leaving
    /// the rest of the repo working — `show`, `log`, and the purge rewrite
    /// (`commit-tree` + `update-ref`) run no hooks. That is exactly the
    /// post-durable-step failure these two tests are about.
    #[cfg(not(mobile))]
    fn block_commits(root: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let hooks = root.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }}
