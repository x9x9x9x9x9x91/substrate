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

/// Everywhere-palette row that names a note: surface it in the main window
/// through the same event the tray agenda and due-date notifications use,
/// then dismiss the palette.
#[tauri::command]
pub(crate) fn palette_open_note(app: tauri::AppHandle, path: String) {
    show_main(&app);
    app.emit("app:open-note", path).ok();
    if let Some(w) = app.get_webview_window("palette") {
        w.hide().ok();
    }
}

/// Everywhere-palette row that names a view (a fixed destination or a
/// dashboard). Its own event rather than a widened `app:open-note`: that one
/// is a bare path string with two other emitters, and a view is not a note.
/// The payload travels as JSON because the shape it has to survive is the
/// frontend's `View` union; the main window checks it (`parseEverywhereView`)
/// before rendering anything.
#[tauri::command]
pub(crate) fn palette_open_view(app: tauri::AppHandle, view: serde_json::Value) {
    show_main(&app);
    app.emit("app:open-view", view).ok();
    if let Some(w) = app.get_webview_window("palette") {
        w.hide().ok();
    }
}

/// ⌘K out of quick capture: swap the capture window for the everywhere
/// palette, carrying whatever was typed over as the palette's opening query.
/// The pivot is the palette's front door now that it ships without a chord of
/// its own, and typing-first is quick capture's whole contract — so the line
/// travels rather than being retyped.
#[tauri::command]
pub(crate) fn capture_pivot_palette(app: tauri::AppHandle, text: String) {
    #[cfg(desktop)]
    {
        if let Some(w) = app.get_webview_window("capture") {
            w.hide().ok();
        }
        // the same two drops the capture window's blur-hide does: the text
        // left with the user, and neither a deep link's prefill nor a context
        // chip may outlive this summon into the next one
        app.state::<crate::deeplink::DeepLinks>().clear_capture_prefill();
        app.state::<crate::context_snapshot::PendingContext>().clear();
        crate::show_palette(&app, text);
    }
    #[cfg(mobile)]
    let _ = (app, text);
}

/// The query the palette should open with, if it was summoned by the pivot
/// above. Reading does not consume it: the palette clears its box on every
/// show and asks afterwards, and a consuming read would race that clear into
/// winning on the second reset. `show_palette` overwrites it on every summon,
/// so a chord-summoned palette reads the empty string.
#[tauri::command]
pub(crate) fn palette_seed_query(app: tauri::AppHandle) -> String {
    #[cfg(desktop)]
    {
        return app
            .state::<crate::SharedRuntime>()
            .0
            .lock()
            .map(|rt| rt.palette_seed.clone())
            .unwrap_or_default();
    }
    #[cfg(mobile)]
    {
        let _ = app;
        String::new()
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
