//! `substrate://` deeplink commands — the two pulls the frontend
//! makes. Parsing, validation and the pending queue live in
//! `crate::deeplink`; these are the moments a window says "I'm ready, give me
//! what arrived".

use crate::deeplink::{DeepLinks, Resolved};
use crate::AppState;
use tauri::Manager;

/// Drain queued links. Called by the main window on mount (which is what
/// marks it ready) and again on every `deeplink:pending`.
///
/// Resolution happens here, not at arrival, because here the vault is loaded:
/// the index lookup is the second gate after `parse` — a path that survived
/// validation but names nothing in *this* vault comes back as a message, never
/// as silence.
#[tauri::command]
pub(crate) fn deeplink_take_pending(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Vec<Resolved> {
    let queued = app.state::<DeepLinks>().take_pending();
    if queued.is_empty() {
        return Vec::new();
    }
    let engine = state.0.lock().unwrap();
    queued
        .into_iter()
        .map(|item| match item {
            Err(msg) => Resolved {
                path: None,
                error: Some(msg),
            },
            Ok(rel) => match engine.meta(&rel) {
                Some(_) => Resolved {
                    path: Some(rel),
                    error: None,
                },
                None => Resolved {
                    path: None,
                    error: Some(format!("No note at “{rel}” in this vault.")),
                },
            },
        })
        .collect()
}

/// Capture window's side of the prefill handoff. It *pulls* rather than being
/// pushed to because the window resets itself on focus (clearing the box), and
/// the reset lands after any event we could emit at show time — so the pull
/// runs after the reset and wins.
///
/// The read does not consume: one link resets the window more than once
/// (`tauri://focus` and `capture:prefill`), and only a repeatable read makes
/// the order those resets resolve in irrelevant. The prefill goes away at
/// `deeplink_clear_capture_prefill` instead.
#[tauri::command]
pub(crate) fn deeplink_capture_prefill(app: tauri::AppHandle) -> Option<String> {
    app.state::<DeepLinks>().capture_prefill()
}

/// The capture window is done with the prefill — the note was filed, or the
/// window hid (Escape, or the blur that hides it). Dropping it here rather
/// than at read time is what keeps the next ⌥Space capture empty without
/// making a second reset race the first.
#[tauri::command]
pub(crate) fn deeplink_clear_capture_prefill(app: tauri::AppHandle) {
    app.state::<DeepLinks>().clear_capture_prefill();
}
