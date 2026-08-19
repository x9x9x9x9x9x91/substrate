//! Tray agenda popover commands. The window helpers they drive
//! (`show_main`, `toggle_capture`) stay in lib.rs with the tray/menu setup
//! that also uses them.

use crate::show_main;
#[cfg(desktop)]
use crate::toggle_capture;
use tauri::{Emitter, Manager};

/// Tray agenda item click: surface the note in the main window — the same
/// event due-date notifications open notes with — then dismiss the popover.
#[tauri::command]
pub(crate) fn agenda_open_note(app: tauri::AppHandle, path: String) {
    show_main(&app);
    app.emit("app:open-note", path).ok();
    if let Some(w) = app.get_webview_window("agenda") {
        w.hide().ok();
    }
}


/// Fit the tray popover to its rendered content.
///
/// `height` is the card's own logical height, clamped here rather than in the
/// webview so the bounds live next to the window that has to honor them. The
/// re-place afterwards is not optional: `setContentSize:` keeps the window's
/// BOTTOM-left corner fixed, so a resize alone walks the top edge up into (or
/// away from) the menu bar. Re-applying the tray anchor pins the top instead.
#[cfg(desktop)]
#[tauri::command]
pub(crate) fn agenda_resize(app: tauri::AppHandle, height: f64) {
    let Some(w) = app.get_webview_window("agenda") else {
        return;
    };
    if !height.is_finite() {
        return;
    }
    let height = height.clamp(crate::AGENDA_MIN_HEIGHT, crate::AGENDA_MAX_HEIGHT);
    if w.set_size(tauri::LogicalSize::new(crate::AGENDA_WIDTH, height)).is_err() {
        return;
    }
    let spot = app.state::<crate::AgendaAnchor>().0.lock().ok().and_then(|a| *a);
    if let Some(spot) = spot {
        let scale = w.scale_factor().unwrap_or(1.0);
        crate::place_agenda(&app, &w, spot, (crate::AGENDA_WIDTH * scale).round() as u32);
    }
}

/// Non-desktop builds have no tray and no popover; the command stays in the
/// handler list so the IPC surface is the same shape everywhere.
#[cfg(mobile)]
#[tauri::command]
pub(crate) fn agenda_resize(app: tauri::AppHandle, height: f64) {
    let _ = (app, height);
}

/// Tray agenda "Capture…" row: swap the popover for the quick-capture window.
#[tauri::command]
pub(crate) fn agenda_open_capture(app: tauri::AppHandle) {
    #[cfg(desktop)]
    {
        if let Some(w) = app.get_webview_window("agenda") {
            w.hide().ok();
        }
        toggle_capture(&app);
    }
    #[cfg(mobile)]
    let _ = app;
}
