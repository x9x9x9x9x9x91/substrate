//! Trash: note and folder deletes, restores and permanent purges.

use crate::{AppState, SnapDirty};
use crate::vault::{NoteMeta, TrashEntry};
use tauri::State;

/// "Delete" from the UI is a move into `.trash/` — recoverable until the
/// trash itself is emptied. Returns the trash id it created so Undo restores
/// exactly this version (SUB-478).
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
/// `deleted_ms` and the Trash pane lists it together in path order (SUB-577).
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
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().trash_restore(&id)
}

#[tauri::command]
pub(crate) fn vault_trash_delete(state: State<AppState>, id: String) -> Result<(), String> {
    state.0.lock().unwrap().trash_delete(&id)
}

/// Restore a trashed template back to `.vault/templates/` (SUB-781); returns
/// the stem it landed under (numbered when the type already has a new one).
#[tauri::command]
pub(crate) fn vault_trash_restore_template(
    state: State<AppState>,
    id: String,
) -> Result<String, String> {
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
/// entry, the same trash semantics as notes. Returns the trash id (SUB-478).
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
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().trash_restore_folder(&id)
}

#[tauri::command]
pub(crate) fn vault_trash_delete_folder(state: State<AppState>, id: String) -> Result<(), String> {
    state.0.lock().unwrap().trash_delete_folder(&id)
}
