//! Assets: save/import/link, orphan sweep, export and printing.

use crate::vault;
use crate::{AppState, SnapDirty};
use tauri::State;

#[tauri::command]
pub(crate) fn vault_save_asset(state: State<AppState>, name: String, data: String) -> Result<String, String> {
    state.0.lock().unwrap().save_asset(&name, &data)
}

#[tauri::command]
pub(crate) fn vault_read_asset(state: State<AppState>, name: String) -> Result<String, String> {
    state.0.lock().unwrap().read_asset(&name)
}

/// Write exported text (CSV etc.) to a destination the user picked in a
/// save dialog — the path never comes from note content.
#[tauri::command]
pub(crate) fn export_text(dest: String, contents: String) -> Result<(), String> {
    std::fs::write(&dest, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn export_note_bundle(
    state: State<AppState>,
    path: String,
    dest_dir: String,
) -> Result<usize, String> {
    state.0.lock().unwrap().export_note_bundle(&path, &dest_dir)
}

/// Open the system print dialog on the main webview — "Save as PDF" there is
/// the note→PDF path.
#[tauri::command]
pub(crate) fn print_window(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    return window.print().map_err(|e| e.to_string());
    #[cfg(mobile)]
    {
        let _ = window;
        Err("printing is desktop-only".into())
    }
}

#[tauri::command]
pub(crate) fn vault_import_asset(state: State<AppState>, path: String) -> Result<String, String> {
    state.0.lock().unwrap().import_asset(&path)
}

#[tauri::command]
pub(crate) fn vault_link_asset(state: State<AppState>, path: String) -> Result<String, String> {
    state.0.lock().unwrap().link_asset(&path)
}

/// Whether a Shift key is physically down right now (SUB-438). Tauri's
/// drag-drop event carries no modifier flags, so the drop handler asks the
/// OS directly at drop time. macOS-only; elsewhere always false, so drops
/// keep the copy behavior.
#[tauri::command]
pub(crate) fn drop_shift_down() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            // Boolean CGEventSourceKeyState(CGEventSourceStateID, CGKeyCode)
            fn CGEventSourceKeyState(state_id: i32, key: u16) -> u8;
        }
        const COMBINED_SESSION_STATE: i32 = 0; // kCGEventSourceStateCombinedSessionState
        const VK_SHIFT: u16 = 0x38;
        const VK_RIGHT_SHIFT: u16 = 0x3C;
        unsafe {
            CGEventSourceKeyState(COMBINED_SESSION_STATE, VK_SHIFT) != 0
                || CGEventSourceKeyState(COMBINED_SESSION_STATE, VK_RIGHT_SHIFT) != 0
        }
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[tauri::command]
pub(crate) fn vault_asset_info(state: State<AppState>, name: String) -> Result<vault::AssetInfo, String> {
    state.0.lock().unwrap().asset_info(&name)
}

#[tauri::command]
pub(crate) fn vault_assets_orphaned(state: State<AppState>) -> Result<Vec<vault::AssetInfo>, String> {
    state.0.lock().unwrap().assets_orphaned()
}

/// Read-only vault integrity report (SUB-432). Takes no `SnapDirty` — it
/// never writes, so there is nothing to mark dirty. The mount bindings come
/// from this machine's app config (SUB-888): the doctor reports an unbound
/// mount, and only the config knows what is bound here.
#[tauri::command]
pub(crate) fn vault_doctor(
    state: State<AppState>,
    onboarding: State<crate::OnboardingState>,
    reflexes: State<crate::reflexes::ReflexState>,
) -> Result<vault::DoctorReport, String> {
    let bindings = crate::appcfg::read_config(&onboarding.config_dir).mounts;
    let mut report = state.0.lock().unwrap().doctor(&bindings)?;
    // appended here, not inside `doctor()`: whether a rule runs is process
    // state (loaded file, breaker), and the doctor only reads the vault
    // (SUB-826 §6)
    if let Ok(loaded) = reflexes.0.lock() {
        report.findings.extend(loaded.doctor_findings());
    }
    Ok(report)
}

#[tauri::command]
pub(crate) fn vault_assets_delete(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    names: Vec<String>,
) -> Result<Vec<Result<String, String>>, String> {
    // .assets/ writes are invisible to the watcher, so mark for snapshot here
    dirty.mark();
    state.0.lock().unwrap().assets_delete(&names)
}

/// Restore a trashed asset back into `.assets/` (SUB-479); returns the name it
/// landed under (numbered when the original name was reoccupied).
#[tauri::command]
pub(crate) fn vault_assets_restore(
    state: State<AppState>,
    dirty: State<SnapDirty>,
    id: String,
) -> Result<String, String> {
    dirty.mark();
    state.0.lock().unwrap().assets_restore(&id)
}

/// Permanently delete one trashed asset — no history copy stands behind it.
#[tauri::command]
pub(crate) fn vault_assets_trash_delete(state: State<AppState>, id: String) -> Result<(), String> {
    state.0.lock().unwrap().assets_trash_delete(&id)
}
