//! Tray agenda popover commands. The window helpers they drive
//! (`show_main`, `toggle_capture`) stay in lib.rs with the tray/menu setup
//! that also uses them.

use crate::show_main;
#[cfg(desktop)]
use crate::toggle_capture;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// A date cell in a sheet's grid: the note holding the sheet, the column the
/// alert fired for, and the row's label cell — the row identity the alert was
/// keyed with. Frontend spelling: `useVaultEvents`'s `SheetRowTarget`.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SheetRow {
    pub(crate) path: String,
    pub(crate) column: String,
    pub(crate) row: String,
}

/// A destination the app was told to open, as the main window receives it:
/// a note path, a view, or a sheet row. Exactly one field is set.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct OpenTarget {
    pub(crate) note: Option<String>,
    pub(crate) view: Option<serde_json::Value>,
    pub(crate) sheet: Option<SheetRow>,
}

#[derive(Default)]
struct OpenTargetsInner {
    queue: Vec<OpenTarget>,
    /// flipped by the first drain — the main window is mounted and its
    /// listeners are up, so everything after it can simply be emitted
    main_ready: bool,
}

/// Destinations that arrived before the main window could receive them.
///
/// `app:open-note` and `app:open-view` are listened for by `App`, which does
/// not mount while the boot frame is up — so a tray agenda click, an
/// everywhere-palette row or a due-date notification arriving during the
/// launch scan emitted into nothing and the destination was lost in silence.
/// Queue-then-drain instead, the same shape deeplinks already use: the first
/// drain IS the window saying it can receive.
#[derive(Default)]
pub(crate) struct OpenTargets(Mutex<OpenTargetsInner>);

impl OpenTargets {
    /// Take a destination in: queued while the main window cannot receive,
    /// handed straight back to be emitted once it can. Split out from
    /// `deliver` so the queue-or-emit decision is testable without an app.
    fn admit(&self, target: OpenTarget) -> Option<OpenTarget> {
        let mut g = self.0.lock().unwrap();
        if g.main_ready {
            return Some(target);
        }
        g.queue.push(target);
        None
    }

    fn deliver(&self, app: &tauri::AppHandle, target: OpenTarget) {
        let Some(target) = self.admit(target) else { return };
        if let Some(path) = target.note {
            app.emit("app:open-note", path).ok();
        } else if let Some(view) = target.view {
            app.emit("app:open-view", view).ok();
        } else if let Some(sheet) = target.sheet {
            app.emit("app:open-sheet-row", sheet).ok();
        }
    }

    /// Hand over everything queued and mark the main window ready — one step
    /// on purpose, exactly as the deeplink queue does it.
    fn take_pending(&self) -> Vec<OpenTarget> {
        let mut g = self.0.lock().unwrap();
        g.main_ready = true;
        std::mem::take(&mut g.queue)
    }
}

/// Surface a note in the main window — the one door for every caller that
/// used to emit `app:open-note` directly.
pub(crate) fn open_note(app: &tauri::AppHandle, path: String) {
    app.state::<OpenTargets>()
        .deliver(app, OpenTarget { note: Some(path), view: None, sheet: None });
}

/// Surface a view in the main window, on the same never-dropped terms.
pub(crate) fn open_view(app: &tauri::AppHandle, view: serde_json::Value) {
    app.state::<OpenTargets>()
        .deliver(app, OpenTarget { note: None, view: Some(view), sheet: None });
}

/// Surface a note and reveal one of its sheet rows, on the same terms. A
/// due-date notification for a sheet cell is the only caller — and it is
/// clickable from the moment the app launches, which is when the main window
/// is least likely to be listening.
pub(crate) fn open_sheet_row(app: &tauri::AppHandle, sheet: SheetRow) {
    app.state::<OpenTargets>()
        .deliver(app, OpenTarget { note: None, view: None, sheet: Some(sheet) });
}

/// Drain destinations that arrived before App mounted. Called by the main
/// window on mount, which is also what marks it ready.
#[tauri::command]
pub(crate) fn open_targets_take_pending(app: tauri::AppHandle) -> Vec<OpenTarget> {
    app.state::<OpenTargets>().take_pending()
}

/// Tray agenda item click: surface the note in the main window — the same
/// event due-date notifications open notes with — then dismiss the popover.
#[tauri::command]
pub(crate) fn agenda_open_note(app: tauri::AppHandle, path: String) {
    show_main(&app);
    open_note(&app, path);
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
    open_note(&app, path);
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
    open_view(&app, view);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn note(path: &str) -> OpenTarget {
        OpenTarget { note: Some(path.to_string()), view: None, sheet: None }
    }

    #[test]
    fn destinations_that_arrive_before_the_window_wait_for_it() {
        let targets = OpenTargets::default();
        assert!(targets.admit(note("a.md")).is_none(), "nothing to emit into yet");
        assert!(targets.admit(note("b.md")).is_none());

        let drained: Vec<_> = targets.take_pending().into_iter().filter_map(|t| t.note).collect();
        assert_eq!(drained, vec!["a.md".to_string(), "b.md".to_string()]);

        // the drain IS the window saying it can receive: from here they go
        // straight out, and a second drain has nothing left to hand over
        assert!(targets.admit(note("c.md")).is_some());
        assert!(targets.take_pending().is_empty());
    }
}
