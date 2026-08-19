//! Context-bound capture — the capture window's side of the snapshot taken at
//! summon time, plus the one place the Accessibility prompt is allowed to
//! appear. The rules and the AppKit calls live in `crate::context_snapshot`.

use crate::context_snapshot::{ContextSnapshot, PendingContext};
use tauri::Manager;

/// What was frontmost when this capture window was summoned, or `None` — the
/// flag is off, Substrate was already frontmost, or nothing could be read.
///
/// Pulled rather than pushed, and the read does not consume: the window
/// resets itself more than once per summon (`tauri://focus` and the prefill
/// event), exactly like `deeplink_capture_prefill`. The snapshot goes away
/// when the window hides or the next summon replaces it.
#[tauri::command]
pub(crate) fn context_pending(app: tauri::AppHandle) -> Option<ContextSnapshot> {
    app.state::<PendingContext>().get()
}

/// Whether macOS already trusts us for Accessibility. Read-only and
/// prompt-free — the Settings row uses it to say whether "Grant access…"
/// still has anything to do.
#[tauri::command]
pub(crate) fn context_ax_trusted() -> bool {
    crate::context_snapshot::ax_trusted()
}

/// Ask for Accessibility access, which shows the system prompt. THE ONLY
/// command that may: it exists so the prompt is something the user pressed a
/// button for, never a side effect of hitting the capture hotkey. Returns
/// trust as it stands after asking — false while the user is still in the
/// System Settings pane macOS opens.
#[tauri::command]
pub(crate) fn context_request_access() -> bool {
    crate::context_snapshot::request_ax_access()
}
