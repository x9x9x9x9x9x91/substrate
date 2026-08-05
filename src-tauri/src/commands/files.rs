//! File-kind props: existence, open/reveal, native pick and text import.

use crate::vault;

// File-kind props link real files anywhere on disk. All path handling stays
// Rust-side so `~/…` expansion lives in one place and the webview needs no
// extra opener/dialog capabilities.

#[tauri::command]
pub(crate) fn path_exists(path: String) -> bool {
    vault::expand_tilde(&path).exists()
}

#[tauri::command]
pub(crate) fn file_open(path: String) -> Result<(), String> {
    let p = vault::expand_tilde(&path);
    if !p.exists() {
        return Err(format!("missing: {path}"));
    }
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn file_reveal(path: String) -> Result<(), String> {
    let p = vault::expand_tilde(&path);
    if !p.exists() {
        return Err(format!("missing: {path}"));
    }
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

// async so the blocking native dialog runs off the IPC thread
#[tauri::command]
pub(crate) async fn file_pick(
    app: tauri::AppHandle,
    dir: bool,
    extensions: Option<Vec<String>>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(exts) = extensions.as_deref().filter(|e| !e.is_empty()) {
        let exts: Vec<&str> = exts.iter().map(String::as_str).collect();
        dialog = dialog.add_filter("Files", &exts);
    }
    let picked = if dir {
        #[cfg(desktop)]
        {
            dialog.blocking_pick_folder()
        }
        // folder picking has no mobile implementation in the dialog plugin
        #[cfg(mobile)]
        None
    } else {
        dialog.blocking_pick_file()
    };
    let path = picked?.into_path().ok()?;
    Some(vault::contract_tilde(&path))
}

/// Read a text file the user picked outside the vault (CSV import).
/// Read-only, tilde-expanded, and capped so a stray multi-GB pick fails
/// instead of stalling the app.
#[tauri::command]
pub(crate) fn file_read_text(path: String) -> Result<String, String> {
    let p = vault::expand_tilde(&path);
    let meta = std::fs::metadata(&p).map_err(|_| format!("missing: {path}"))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("file too large to import".into());
    }
    std::fs::read_to_string(&p).map_err(|e| format!("couldn't read {path}: {e}"))
}

/// Loose (non-note) files directly inside one vault folder — the
/// folder view's file rows. Deliberately its own lazy call rather than part
/// of the vault index: the scan stays `.md`-only, and a folder full of
/// masters costs one `read_dir` when you open it and nothing when you don't.
/// Read-only, so it takes no `SnapDirty`.
#[tauri::command]
pub(crate) fn vault_folder_files(
    state: tauri::State<crate::AppState>,
    path: String,
) -> Result<vault::FolderListing, String> {
    state.0.lock().unwrap().folder_files(&path)
}
