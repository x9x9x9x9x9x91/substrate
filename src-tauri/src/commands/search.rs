//! Search, backlinks and wiki-link resolution.

use crate::vault::{self, FullSearchResult, ImageHit, NoteMeta, SearchHit};
use crate::AppState;
use tauri::State;

/// `scope`, when present, is the allow-list of paths the caller's structured
/// filters left standing — the engine applies it before its LIMIT.
/// `exclude_app_files` mirrors the conceal toggle: true while
/// the app hides AGENTS.md/CLAUDE.md/Settings.md, so counts and pages are
/// drawn from the notes the user can actually see. Optional so the
/// flag's absence means the historical behavior (nothing excluded).
#[tauri::command]
pub(crate) fn vault_search(
    state: State<AppState>,
    q: String,
    scope: Option<Vec<String>>,
    exclude_app_files: Option<bool>,
) -> Vec<SearchHit> {
    state.0.lock().unwrap().search(&q, scope.as_deref(), exclude_app_files.unwrap_or(false))
}

#[tauri::command]
pub(crate) fn vault_search_full(
    state: State<AppState>,
    q: String,
    scope: Option<Vec<String>>,
    exclude_app_files: Option<bool>,
) -> FullSearchResult {
    state.0.lock().unwrap().search_full(&q, scope.as_deref(), exclude_app_files.unwrap_or(false))
}

/// The image behind a search hit whose text was recognized: the picture's
/// location on this machine, the recognized text, and the label saying it is
/// machine-read. `None` for an image that is gone or was never read here.
#[tauri::command]
pub(crate) fn vault_image_hit(state: State<AppState>, rel: String) -> Option<ImageHit> {
    state.0.lock().unwrap().image_hit(&rel)
}

#[tauri::command]
pub(crate) fn vault_backlinks(state: State<AppState>, path: String) -> Vec<NoteMeta> {
    state.0.lock().unwrap().backlinks(&path)
}

#[tauri::command]
pub(crate) fn vault_related(state: State<AppState>, path: String) -> Vec<vault::RelatedEntry> {
    state.0.lock().unwrap().related(&path)
}

#[tauri::command]
pub(crate) fn vault_resolve(state: State<AppState>, name: String) -> Option<NoteMeta> {
    state.0.lock().unwrap().resolve_link(&name)
}
