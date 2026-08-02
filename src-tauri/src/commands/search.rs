//! Search, backlinks and wiki-link resolution.

use crate::vault::{self, FullSearchResult, NoteMeta, SearchHit};
use crate::AppState;
use tauri::State;

/// `scope`, when present, is the allow-list of paths the caller's structured
/// filters left standing (SUB-566) — the engine applies it before its LIMIT.
#[tauri::command]
pub(crate) fn vault_search(state: State<AppState>, q: String, scope: Option<Vec<String>>) -> Vec<SearchHit> {
    state.0.lock().unwrap().search(&q, scope.as_deref())
}

#[tauri::command]
pub(crate) fn vault_search_full(
    state: State<AppState>,
    q: String,
    scope: Option<Vec<String>>,
) -> FullSearchResult {
    state.0.lock().unwrap().search_full(&q, scope.as_deref())
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
