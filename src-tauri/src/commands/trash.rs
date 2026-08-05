//! Trash: note and folder deletes, restores and permanent purges.

use crate::vault::{NoteMeta, TrashEntry};
use crate::{AppState, HistoryState, SnapDirty};
use tauri::State;

/// "Delete" from the UI is a move into `.trash/` — recoverable until the
/// trash itself is emptied. Returns the trash id it created so Undo restores
/// exactly this version.
#[tauri::command]
pub(crate) fn vault_delete(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().trash(&path)
}

/// Bulk "Delete" — one call for a whole multi-select, so the group shares a
/// `deleted_ms` and the Trash pane lists it together in path order.
/// A per-note loop on the frontend split the group across a millisecond
/// boundary under load. Returns one entry per input path, in order: `Ok(id)`
/// or `Err(message)`, so a partial failure stays per-note attributable.
#[tauri::command]
pub(crate) fn vault_delete_many(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    paths: Vec<String>,
) -> Vec<Result<String, String>> {
    dirty.mark();
    state.0.lock().unwrap().trash_many(&paths)
}

#[tauri::command]
pub(crate) fn vault_trash_list(state: State<AppState>) -> Vec<TrashEntry> {
    state.0.lock().unwrap().trash_list()
}

#[tauri::command]
pub(crate) fn vault_trash_restore(
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<NoteMeta, String> {
    dirty.mark();
    let original = id.split_once('/').map(|(_, path)| path.to_string()).unwrap_or_default();
    let hist = history.0.lock().unwrap();
    let mut engine = state.0.lock().unwrap();
    let result = engine.trash_restore(&id);
    let restored_to = result.as_ref().ok().map(|meta| meta.path.clone());
    super::finish_inherited_seal(&app, &mut engine, hist.as_ref(), result, |converted| {
        super::prior_path_when_converted(converted, restored_to.as_ref(), &original)
    })
}

#[tauri::command]
pub(crate) fn vault_trash_delete(state: State<AppState>, id: String) -> Result<(), String> {
    state.0.lock().unwrap().trash_delete(&id)
}

/// Restore a trashed template back to `.vault/templates/`; returns
/// the stem it landed under (numbered when the type already has a new one).
/// Marks the vault dirty: templates sit outside the watcher, so without it
/// the restored file waits for an unrelated mutation before any snapshot.
#[tauri::command]
pub(crate) fn vault_trash_restore_template(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().trash_restore_template(&id)
}

#[tauri::command]
pub(crate) fn vault_trash_delete_template(
    state: State<AppState>,
    id: String,
) -> Result<(), String> {
    state.0.lock().unwrap().trash_delete_template(&id)
}

#[tauri::command]
pub(crate) fn vault_trash_empty(state: State<AppState>) -> Result<(), String> {
    state.0.lock().unwrap().trash_empty()
}

/// Folder delete — the whole subtree moves into `.trash/` as one recoverable
/// entry, the same trash semantics as notes. Returns the trash id.
#[tauri::command]
pub(crate) fn vault_delete_folder(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().trash_folder(&path)
}

/// Restore a trashed folder subtree; returns the rel path it landed at
/// (numbered when the original path was reoccupied).
#[tauri::command]
pub(crate) fn vault_trash_restore_folder(
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<String, String> {
    dirty.mark();
    let hist = history.0.lock().unwrap();
    let mut engine = state.0.lock().unwrap();
    let prior = engine
        .trash_list()
        .into_iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.notes)
        .unwrap_or_default();
    let original = id.split_once('/').map(|(_, path)| path.to_string()).unwrap_or_default();
    let result = engine.trash_restore_folder(&id);
    super::finish_inherited_seal(&app, &mut engine, hist.as_ref(), result, |converted| {
        super::matching_prior_paths(converted, &prior, &original)
    })
}

#[tauri::command]
pub(crate) fn vault_trash_delete_folder(state: State<AppState>, id: String) -> Result<(), String> {
    state.0.lock().unwrap().trash_delete_folder(&id)
}
