//! Version history: the git-backed snapshot panel (list, diff, restore) plus
//! the purge/trim commands that rewrite it.

use crate::history::{DiffLine, History, HistoryEntry, VaultHistoryPoint};
use crate::vault::{
    fm_state, note_from_history, Engine, FmState, FolderMeta, NoteContent, NoteMeta, SavedView,
    SchemaConfig, SidebarOrder, ViewPref,
};
use crate::{blocking, AppState, HistoryState, SnapDirty};
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};
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
/// engine mutex.
///
/// LOCK ORDER — history first, then the engine. Every site that holds both
/// takes them in that order (`history_restore` above does the same), so the
/// nesting can never invert into an ABBA deadlock. `vault_sync_pull` and
/// `vault_sync_resolve_finish` take the history lock first too and keep it
/// while taking the engine lock for their destructive local phase.
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

/// A complete read-only vault projection at one history commit. Note bodies
/// and the three view/config projections come from the same tree, so an old
/// database always renders against its old schema instead of today's files.
#[derive(serde::Serialize)]
pub(crate) struct HistoryVaultSnapshot {
    point: VaultHistoryPoint,
    notes: Vec<NoteMeta>,
    contents: HashMap<String, NoteContent>,
    /// Raw frontmatter per note, as of this snapshot. `read()`
    /// strips the block, so without this the frontmatter panel showed every
    /// historical note as having none.
    fm: HashMap<String, FmState>,
    folders: Vec<String>,
    views: HashMap<String, ViewPref>,
    schema: SchemaConfig,
    sidebar_order: SidebarOrder,
    saved_views: Vec<SavedView>,
    folder_meta: HashMap<String, FolderMeta>,
}

fn json_or_default<T: DeserializeOwned + Default>(raw: Option<&String>) -> T {
    raw.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
}

pub(crate) fn build_vault_snapshot(
    hist: &History,
    id: &str,
) -> Result<HistoryVaultSnapshot, String> {
    let point = hist
        .points()?
        .into_iter()
        .find(|point| point.id == id)
        .ok_or_else(|| "version history snapshot unavailable".to_string())?;
    let files: HashMap<String, String> = hist.snapshot_files(id)?.into_iter().collect();
    let mut notes = Vec::new();
    let mut contents = HashMap::new();
    let mut fm = HashMap::new();
    let mut folder_set = HashSet::new();
    for (path, raw) in &files {
        let Some((meta, content)) = note_from_history(path, raw, point.ts_ms) else { continue };
        if let Some(state) = fm_state(raw) {
            fm.insert(path.clone(), state);
        }
        let mut folder = meta.folder.as_str();
        while !folder.is_empty() {
            folder_set.insert(folder.to_string());
            folder = folder.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
        }
        contents.insert(path.clone(), content);
        notes.push(meta);
    }
    // A git tree has no mtimes. Avoid pretending every note changed at once
    // by using a deterministic path order inside this historical projection.
    notes.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    let mut folders: Vec<String> = folder_set.into_iter().collect();
    folders.sort_by_key(|folder| folder.to_lowercase());

    let schema = json_or_default(files.get(".vault/schema.json"));
    let view_root: serde_json::Map<String, serde_json::Value> =
        json_or_default(files.get(".vault/views.json"));
    let views = view_root
        .iter()
        .filter(|(key, _)| !key.starts_with('$'))
        .filter_map(|(key, value)| {
            serde_json::from_value::<ViewPref>(value.clone()).ok().map(|view| (key.clone(), view))
        })
        .collect();
    let sidebar_order = view_root
        .get("$sidebar")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let saved_views = view_root
        .get("$views")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    let folder_meta = view_root
        .get("$folders")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();

    Ok(HistoryVaultSnapshot {
        point,
        notes,
        contents,
        fm,
        folders,
        views,
        schema,
        sidebar_order,
        saved_views,
        folder_meta,
    })
}

#[tauri::command]
pub(crate) async fn history_points(
    app: tauri::AppHandle,
) -> Result<Vec<VaultHistoryPoint>, String> {
    blocking(move || {
        let h: State<HistoryState> = app.state();
        with_history(&h, History::points)
    })
    .await?
}

#[tauri::command]
pub(crate) async fn history_vault_snapshot(
    app: tauri::AppHandle,
    id: String,
) -> Result<HistoryVaultSnapshot, String> {
    blocking(move || {
        let h: State<HistoryState> = app.state();
        with_history(&h, |hist| build_vault_snapshot(hist, &id))
    })
    .await?
}

// async so a slow git log (large history, cold cache) can't freeze the UI.
// The state is fetched INSIDE the blocking closure: a std MutexGuard is not
// Send, so it must never be held across an await.
#[tauri::command]
pub(crate) async fn history_list(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<HistoryEntry>, String> {
    blocking(move || {
        let h: State<HistoryState> = app.state();
        with_history(&h, |hist| hist.list(&path))
    })
    .await?
}

/// One fact a caller wants the history of: a note path and a frontmatter key.
#[derive(serde::Deserialize)]
pub(crate) struct FactRef {
    pub path: String,
    pub key: String,
}

/// The lanes behind `AT()`, `PROP()` and the chart `history:` source
/// (docs/time-travel-spec.md §7.2). Batched because a dashboard asks about
/// several facts at once and each round trip otherwise re-opens the repository
/// and re-walks it for the oldest-snapshot boundary. Async for the same reason
/// `history_list` is: the walk is git work, not UI work.
#[tauri::command]
pub(crate) async fn history_facts(
    app: tauri::AppHandle,
    refs: Vec<FactRef>,
) -> Result<Vec<crate::factlane::FactLane>, String> {
    blocking(move || {
        let pairs: Vec<(String, String)> = refs.into_iter().map(|r| (r.path, r.key)).collect();
        let h: State<HistoryState> = app.state();
        with_history(&h, |hist| hist.fact_lanes(&pairs))
    })
    .await?
}

/// One instant's sheet world: the sheets that existed then, with the bodies
/// the formula fence is parsed out of. `oldest_ts_ms` travels with it so a
/// caller can tell "the vault had no snapshot yet" (answerable: nothing
/// existed) from "this is before the vault's history begins" (unknowable) —
/// the trim trap, which must never render as a zero (§2.3).
#[derive(serde::Serialize)]
pub(crate) struct HistorySheets {
    instant_ms: u64,
    commit: Option<String>,
    oldest_ts_ms: Option<u64>,
    sheets: Vec<HistorySheetNote>,
}

#[derive(serde::Serialize)]
pub(crate) struct HistorySheetNote {
    path: String,
    title: String,
    stem: String,
    body: String,
}

/// The historical sheets behind `AT(date, Sheet.member)` (§3.2). Instants, not
/// dates: "the last moment of that day" is the reader's own calendar, and the
/// front end already computes it for fact lanes — sending the resolved instant
/// keeps one definition of the boundary instead of two that can drift.
/// Batched and async for the same reasons `history_facts` is.
#[tauri::command]
pub(crate) async fn history_sheets(
    app: tauri::AppHandle,
    instants: Vec<u64>,
) -> Result<Vec<HistorySheets>, String> {
    blocking(move || {
        let h: State<HistoryState> = app.state();
        with_history(&h, |hist| {
            Ok(hist
                .sheets_at(&instants)?
                .into_iter()
                .map(|at| {
                    // the snapshot's OWN time, not the instant that was asked
                    // for: the answering commit is the newest one at or before
                    // that instant, and a note stamped with the question rather
                    // than the answer is a lie the moment anything reads it as
                    // provenance
                    let ts = at.commit_ts_ms.unwrap_or(0);
                    let sheets = at
                        .files
                        .iter()
                        .filter_map(|(path, raw)| {
                            let (meta, content) = note_from_history(path, raw, ts)?;
                            Some(HistorySheetNote {
                                path: meta.path,
                                title: meta.title,
                                stem: meta.stem,
                                body: content.body,
                            })
                        })
                        .collect();
                    HistorySheets {
                        instant_ms: at.instant_ms,
                        commit: at.commit,
                        oldest_ts_ms: at.oldest_ts_ms,
                        sheets,
                    }
                })
                .collect())
        })
    })
    .await?
}

#[tauri::command]
pub(crate) fn history_diff(
    h: State<HistoryState>,
    id: String,
    file: String,
) -> Result<Vec<DiffLine>, String> {
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
/// panel opening and the click, and the restore is about to bury it.
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
    // A sealed note's history restarted at version 1 = ciphertext, so any
    // restorable version IS ciphertext — write_raw would encrypt it AGAIN
    // (unreadable forever) or, for pre-seal leftovers, write plaintext into a
    // sealed file. Both are corruption; remove the seal first.
    if engine.meta(path).is_some_and(|m| m.sealed) {
        return Err(
            "history restore is unavailable for a sealed note — remove the seal first".into()
        );
    }
    let content = hist.show(id, file)?;
    // read before the write — afterwards the mtime is our own
    let overwrote_external =
        baseline_ms > 0 && engine.disk_mtime_ms(path).is_some_and(|disk| disk > baseline_ms);
    if overwrote_external {
        hist.snapshot(&format!("external edit to {} before restore", path)).ok();
    }
    let meta = engine.write_raw(path, &content)?;
    // The file is replaced by this point, so the snapshot after it is
    // bookkeeping and must not fail the restore. Reporting Err here
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
        // meta must reach the caller either way
        if out.overwrote_external {
            use tauri::Emitter;
            app.emit("history:restored-over-external", RestoredOverExternal { path }).ok();
        }
        Ok(out.meta)
    })
    .await?
}

/// Every command here replays history under new commit ids, which is exactly
/// what makes the historical search index stale AND a second copy of writing
/// the user just destroyed. Deep Recall notices a replayed history on its own
/// when it is next read, so this is belt to that braces: the copy goes away
/// with the rewrite rather than with the next search.
fn drop_recall_index(app: &tauri::AppHandle, state: &State<AppState>) {
    let onboarding: State<crate::OnboardingState> = app.state();
    let root = state.0.lock().unwrap().root.clone();
    crate::commands::recall::clear_after_rewrite(&onboarding.config_dir, &root);
}

/// Purge notes out of all snapshots, then re-snapshot so their current state
/// becomes a fresh version 1. Split out of the two commands below so a test
/// can drive the real sequence.
pub(crate) fn purge_notes(hist: &History, rels: &[&str]) -> Result<(), String> {
    hist.purge_files(rels)?;
    // The rewrite ends in `reflog expire --expire=now` + `gc --prune=now`, so
    // by this point the old versions are unrecoverable. A failing re-snapshot
    // must not turn that into an Err: TrashPane deliberately chains
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
pub(crate) async fn history_purge_note(app: tauri::AppHandle, path: String) -> Result<(), String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let h: State<HistoryState> = app.state();
        with_history_rewrite(&h.0, &state.0, |hist| purge_notes(hist, &[&path]))?;
        drop_recall_index(&app, &state);
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
        drop_recall_index(&app, &state);
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
        let out = with_history_rewrite(&h.0, &state.0, |hist| hist.trim_before(before_ms / 1000));
        drop_recall_index(&app, &state);
        out
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
    /// These rewrites can take seconds or minutes, so their command
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

    /// A snapshot that fails AFTER the file has been replaced must
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

    /// Review: a sealed note's restorable versions are ciphertext
    /// (history restarts at v1 = ciphertext on seal), and write_raw would
    /// re-encrypt them — a doubly-encrypted, permanently unreadable file.
    /// Restore refuses while the seal stands, even unlocked.
    #[cfg(not(mobile))]
    #[test]
    fn restore_refuses_a_sealed_note() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Vault");
        std::fs::create_dir_all(&root).unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let meta = engine.create("Secret", "", None).unwrap();
        let hist = crate::history::History::new(root.clone()).unwrap();
        hist.snapshot("plaintext").unwrap();
        crate::commands::notes::seal_note_and_purge(
            &mut engine,
            Some(&hist),
            &meta.path,
            Some("correct horse"),
        )
        .unwrap();
        let v1 = hist.list(&meta.path).unwrap()[0].clone();
        // locked AND unlocked both refuse — the seal, not the lock, is the gate
        let err =
            super::restore_note(&mut engine, &hist, &meta.path, &v1.id, &v1.file, 0).unwrap_err();
        assert!(err.contains("sealed"), "{err}");
        engine.unlock_sealed_note(&meta.path, Some("correct horse")).unwrap();
        let err =
            super::restore_note(&mut engine, &hist, &meta.path, &v1.id, &v1.file, 0).unwrap_err();
        assert!(err.contains("sealed"), "{err}");
    }

    /// An edit that landed on disk after the panel read the note is
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

        let loud =
            super::restore_note(&mut engine, &hist, &meta.path, &old.id, &old.file, baseline)
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
        let buried_in_history =
            hist.list(&meta.path).unwrap().iter().any(|e| {
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

    /// The purge rewrite ends in `reflog expire --expire=now` +
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

    /// A purge/trim rewrite must not run while a pull's local phase
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

    /// One commit must project notes, schema and saved-view config
    /// from that SAME tree, and reading it must leave the live worktree byte
    /// for byte alone.
    #[test]
    fn vault_snapshot_is_a_coherent_read_only_tree_projection() {
        let t = tempfile::TempDir::new().unwrap();
        let root = t.path().join("Vault");
        std::fs::create_dir_all(root.join("Projects")).unwrap();
        std::fs::create_dir_all(root.join(".vault")).unwrap();
        std::fs::write(
            root.join("Projects/One.md"),
            "---\ntype: release\nstatus: draft\n---\nold body\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".vault/schema.json"),
            r#"{"release":{"status":{"kind":"text"}}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join(".vault/views.json"),
            r#"{"release":{"view":"board"},"$sidebar":{"databases":["release"]},"$views":[{"id":"drafts","name":"Drafts","db":"release","query":"status:draft"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("archive.bin"), vec![7_u8; 128]).unwrap();
        let hist = crate::history::History::new(root.clone()).unwrap();
        hist.snapshot("old vault").unwrap();
        let old = hist.points().unwrap()[0].clone();

        std::fs::write(
            root.join("Projects/One.md"),
            "---\ntype: release\nstatus: live\n---\ncurrent body\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".vault/schema.json"),
            r#"{"release":{"status":{"options":[{"value":"live"}]}}}"#,
        )
        .unwrap();
        std::fs::write(root.join(".vault/views.json"), r#"{"release":{"view":"table"}}"#).unwrap();
        hist.snapshot("current vault").unwrap();
        assert_eq!(
            crate::githist::history_points(&root).unwrap(),
            hist.points().unwrap(),
            "the mobile/libgit2 scrubber order matches desktop git"
        );
        let live_before = std::fs::read(root.join("Projects/One.md")).unwrap();

        let snapshot = super::build_vault_snapshot(&hist, &old.id).unwrap();

        assert_eq!(snapshot.point, old);
        assert_eq!(snapshot.notes.len(), 1);
        assert_eq!(snapshot.contents["Projects/One.md"].body, "old body\n");
        assert_eq!(snapshot.contents["Projects/One.md"].props["status"], "draft");
        assert_eq!(snapshot.schema["release"].props["status"].kind.as_deref(), Some("text"));
        assert_eq!(snapshot.views["release"].view, "board");
        assert_eq!(snapshot.sidebar_order.databases, vec!["release"]);
        assert_eq!(snapshot.saved_views[0].id, "drafts");
        assert!(
            hist.snapshot_files(&old.id).unwrap().iter().all(|(path, _)| path != "archive.bin"),
            "unrelated tracked blobs are not loaded into the time projection"
        );
        assert_eq!(
            std::fs::read(root.join("Projects/One.md")).unwrap(),
            live_before,
            "historical projection never checks out over the live vault"
        );

        std::fs::remove_file(root.join("Projects/One.md")).unwrap();
        std::fs::remove_dir(root.join("Projects")).unwrap();
        let mut engine = crate::vault::Engine::new(root.clone());
        let restored = super::restore_note(
            &mut engine,
            &hist,
            "Projects/One.md",
            &old.id,
            "Projects/One.md",
            0,
        )
        .unwrap();
        assert_eq!(restored.meta.path, "Projects/One.md");
        assert!(root.join("Projects/One.md").is_file(), "restore recreates an old folder");
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
    }
}
