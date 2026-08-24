//! View prefs, saved views, folders and the sidebar order.

use crate::vault::{NoteMeta, SavedView, SavedViewSort, SidebarOrder, ViewPref};
use crate::{AppState, HistoryState, SnapDirty};
use tauri::State;

#[tauri::command]
pub(crate) fn vault_views_read(
    state: State<AppState>,
) -> std::collections::HashMap<String, ViewPref> {
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
    col_order: Option<Vec<String>>,
    hidden: Option<Vec<String>>,
    widths: Option<std::collections::BTreeMap<String, u32>>,
    wrap: Option<Vec<String>>,
    grid: Option<bool>,
    hidden_per_layout: Option<crate::vault::HiddenPerLayout>,
    card_order: Option<Vec<String>>,
    group_order: Option<Vec<String>>,
    collapsed_groups: Option<Vec<String>>,
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
        col_order,
        hidden,
        widths,
        wrap,
        grid,
        hidden_per_layout,
        card_order,
        group_order,
        collapsed_groups,
    )
}

#[tauri::command]
pub(crate) fn vault_folder_meta_read(
    state: State<AppState>,
) -> std::collections::HashMap<String, crate::vault::FolderMeta> {
    state.0.lock().unwrap().folder_meta()
}

/// Set or clear a folder's icon — the whole icon at once; no mark
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
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    dirty: State<SnapDirty>,
    path: String,
    name: String,
) -> Result<String, String> {
    dirty.mark();
    let hist = history.0.lock().unwrap();
    let mut engine = state.0.lock().unwrap();
    let prior = engine.markdown_paths_in_folder(&path);
    let result = engine.rename_folder(&path, &name);
    super::finish_inherited_seal(&app, &mut engine, hist.as_ref(), result, |converted| {
        super::matching_prior_paths(converted, &prior, &path)
    })
}

#[tauri::command]
pub(crate) fn vault_move_folder(
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    dirty: State<SnapDirty>,
    path: String,
    folder: String,
) -> Result<String, String> {
    dirty.mark();
    let hist = history.0.lock().unwrap();
    let mut engine = state.0.lock().unwrap();
    let prior = engine.markdown_paths_in_folder(&path);
    let result = engine.move_folder(&path, &folder);
    super::finish_inherited_seal(&app, &mut engine, hist.as_ref(), result, |converted| {
        super::matching_prior_paths(converted, &prior, &path)
    })
}

#[tauri::command]
pub(crate) fn vault_move(
    app: tauri::AppHandle,
    state: State<AppState>,
    history: State<HistoryState>,
    dirty: State<SnapDirty>,
    path: String,
    folder: String,
) -> Result<NoteMeta, String> {
    dirty.mark();
    let hist = history.0.lock().unwrap();
    let mut engine = state.0.lock().unwrap();
    let result = engine.move_note(&path, &folder);
    let moved_to = result.as_ref().ok().map(|meta| meta.path.clone());
    super::finish_inherited_seal(&app, &mut engine, hist.as_ref(), result, |converted| {
        super::prior_path_when_converted(converted, moved_to.as_ref(), &path)
    })
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
