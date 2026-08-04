//! Tags and tag folders (SUB-818).
//!
//! Per-note tags are already on `NoteMeta` (computed at index time), so the
//! frontend gets them free with every note it already loads. These commands
//! cover what the index alone cannot answer: the vault-wide tag universe
//! (autocomplete + the builder's chip picker), the tag folder definitions in
//! `.vault/tagfolders.json`, and the acting-tags write.

use crate::vault::{NoteMeta, TagCount, TagFolder};
use crate::{AppState, SnapDirty};
use tauri::State;

/// Every tag in the vault with its note count, most-used first — the source
/// for `#` autocomplete and the tag folder builder's chip picker.
#[tauri::command]
pub(crate) fn vault_tags(state: State<AppState>) -> Vec<TagCount> {
    state.0.lock().unwrap().tag_universe()
}

#[tauri::command]
pub(crate) fn vault_tag_folders_read(state: State<AppState>) -> Vec<TagFolder> {
    state.0.lock().unwrap().tag_folders()
}

/// Replace the whole tag folder list. Whole-list writes (rather than
/// per-folder patches) keep ordering authoritative on the frontend, matching
/// how saved views and the sidebar order already work.
#[tauri::command]
pub(crate) fn vault_tag_folders_write(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    folders: Vec<TagFolder>,
) -> Result<Vec<TagFolder>, String> {
    // .vault/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    // one lock for write and read-back: the validated list the caller gets is
    // the state this write left behind, never a concurrent writer's
    state.0.lock().unwrap().write_tag_folders(&folders)
}

/// Add tags to a note — what "acting inside a tag folder" does. Writes only
/// the `tags:` prop; the note never moves on disk.
#[tauri::command]
pub(crate) fn vault_note_add_tags(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    path: String,
    tags: Vec<String>,
) -> Result<NoteMeta, String> {
    dirty.mark();
    state.0.lock().unwrap().add_tags(&path, &tags)
}
