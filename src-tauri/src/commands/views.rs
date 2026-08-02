//! View prefs, saved views, folders and the sidebar order.

use crate::vault::{NoteMeta, SavedView, SavedViewSort, SidebarOrder, ViewPref};
use crate::{AppState, SnapDirty};
use tauri::State;

#[tauri::command]
pub(crate) fn vault_views_read(state: State<AppState>) -> std::collections::HashMap<String, ViewPref> {
    state.0.lock().unwrap().views()
}

#[tauri::command]
pub(crate) fn vault_views_set(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    db: String,
    view: String,
    group_by: Option<String>,
    table_group_by: Option<String>,
    aggregations: Option<std::collections::BTreeMap<String, String>>,
    sorts: Option<Vec<SavedViewSort>>,
    hidden: Option<Vec<String>>,
    widths: Option<std::collections::BTreeMap<String, u32>>,
    wrap: Option<Vec<String>>,
    grid: Option<bool>,
    hidden_per_layout: Option<crate::vault::HiddenPerLayout>,
) -> Result<std::collections::HashMap<String, ViewPref>, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().set_view_pref(
        &db,
        &view,
        group_by.as_deref(),
        table_group_by.as_deref(),
        aggregations,
        sorts,
        hidden,
        widths,
        wrap,
        grid,
        hidden_per_layout,
    )
}

#[tauri::command]
pub(crate) fn vault_folder_meta_read(
    state: State<AppState>,
) -> std::collections::HashMap<String, crate::vault::FolderMeta> {
    state.0.lock().unwrap().folder_meta()
}

/// Set or clear a folder's icon (SUB-84) — the whole icon at once; no mark
/// at all removes the entry (plain folder glyph fallback).
#[tauri::command]
pub(crate) fn vault_folder_icon_set(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    glyph: Option<String>,
    emoji: Option<String>,
    tint: Option<String>,
) -> Result<std::collections::HashMap<String, crate::vault::FolderMeta>, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    let icon = match (glyph, emoji) {
        (None, None) => None,
        (glyph, emoji) => Some(crate::vault::DbIcon { glyph, emoji, tint }),
    };
    state.0.lock().unwrap().set_folder_icon(&path, icon)
}

#[tauri::command]
pub(crate) fn vault_folders(state: State<AppState>) -> Vec<String> {
    state.0.lock().unwrap().folders()
}

#[tauri::command]
pub(crate) fn vault_create_folder(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().create_folder(&path)
}

#[tauri::command]
pub(crate) fn vault_rename_folder(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    name: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().rename_folder(&path, &name)
}

#[tauri::command]
pub(crate) fn vault_move_folder(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    folder: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().move_folder(&path, &folder)
}

#[tauri::command]
pub(crate) fn vault_move(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    folder: String,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().move_note(&path, &folder)
}

#[tauri::command]
pub(crate) fn vault_sidebar_order(state: State<AppState>) -> SidebarOrder {
    state.0.lock().unwrap().sidebar_order()
}

#[tauri::command]
pub(crate) fn vault_set_sidebar_order(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    order: SidebarOrder,
) -> Result<SidebarOrder, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().set_sidebar_order(&order)
}

#[tauri::command]
pub(crate) fn vault_saved_views_read(state: State<AppState>) -> Vec<SavedView> {
    state.0.lock().unwrap().saved_views()
}

#[tauri::command]
pub(crate) fn vault_saved_view_set(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    view: SavedView,
) -> Result<Vec<SavedView>, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().set_saved_view(&view)
}

#[tauri::command]
pub(crate) fn vault_saved_view_delete(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<Vec<SavedView>, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().delete_saved_view(&id)
}
