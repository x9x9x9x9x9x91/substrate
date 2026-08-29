//! Search, backlinks and wiki-link resolution.
//!
//! These are the read-hot commands: search runs on every keystroke in the
//! quick opener and the search pane, backlinks and related run on every note
//! open. They all take `AppHandle` and go through [`blocking`] so a slow
//! answer never stalls the IPC thread — see the threading section of
//! docs/architecture.md.
//!
//! Backlinks and related answer from the published index copy and take no
//! lock. Search does not, and cannot as things stand: its answer comes out
//! of the full-text tables in the engine's in-memory SQLite connection,
//! which is private to that one handle and cannot be shared or copied. So
//! search still waits for a mount scan, a seal conversion or a folder sync
//! to finish — off the IPC thread, but waiting.

use crate::vault::{self, FullSearchResult, ImageHit, NoteMeta, SearchHit};
use crate::{blocking, AppState};
use tauri::{Manager, State};

/// `scope`, when present, is the allow-list of paths the caller's structured
/// filters left standing — the engine applies it before its LIMIT.
/// `exclude_app_files` mirrors the conceal toggle: true while
/// the app hides AGENTS.md/CLAUDE.md/Settings.md, so counts and pages are
/// drawn from the notes the user can actually see. Optional so the
/// flag's absence means the historical behavior (nothing excluded).
#[tauri::command]
pub(crate) async fn vault_search(
    app: tauri::AppHandle,
    q: String,
    scope: Option<Vec<String>>,
    exclude_app_files: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let engine = state.0.lock().unwrap();
        engine.search(&q, scope.as_deref(), exclude_app_files.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_search_full(
    app: tauri::AppHandle,
    q: String,
    scope: Option<Vec<String>>,
    exclude_app_files: Option<bool>,
) -> Result<FullSearchResult, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let engine = state.0.lock().unwrap();
        engine.search_full(&q, scope.as_deref(), exclude_app_files.unwrap_or(false))
    })
    .await
}

/// The image behind a search hit whose text was recognized: the picture's
/// location on this machine, the recognized text, and the label saying it is
/// machine-read. `None` for an image that is gone or was never read here.
#[tauri::command]
pub(crate) async fn vault_image_hit(
    app: tauri::AppHandle,
    rel: String,
) -> Result<Option<ImageHit>, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let engine = state.0.lock().unwrap();
        engine.image_hit(&rel)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_backlinks(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<NoteMeta>, String> {
    blocking(move || crate::read_index(&app).backlinks(&path)).await
}

#[tauri::command]
pub(crate) async fn vault_related(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<vault::RelatedEntry>, String> {
    blocking(move || crate::read_index(&app).related(&path)).await
}

#[tauri::command]
pub(crate) async fn vault_resolve(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<NoteMeta>, String> {
    blocking(move || {
        let state: State<AppState> = app.state();
        let engine = state.0.lock().unwrap();
        engine.resolve_link(&name)
    })
    .await
}
