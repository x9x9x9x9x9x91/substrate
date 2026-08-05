/*! Desktop-through-the-window vibrancy (SUB-951, macOS only).

The blur is the OS material's — an `NSVisualEffectView` behind our content —
never a CSS `backdrop-filter`, which would blur the notes themselves. AppKit
composites the desktop behind the window; the frontend then paints its own
ground at the user's chosen alpha on top, so the dial reads as "how much
desktop shows through" rather than "how blurry".

At 100% the material is REMOVED, not merely covered: no effect view in the
hierarchy means no per-frame blur work and rendering that is bit-for-bit the
opaque app we shipped before this setting existed. */

use tauri::{AppHandle, Manager};
use window_vibrancy::{
    apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
};

/// Re-apply the window material for `opacity` (80–100, see [`crate::vault::Settings`]).
///
/// Safe to call repeatedly — every call clears the previously installed effect
/// view first, because `apply_vibrancy` ADDS a subview rather than replacing
/// one, and this runs again on every Settings.md save.
///
/// AppKit is main-thread-only and the settings watcher is not, so the work is
/// hopped onto the main thread; a failure to hop, or a material the running
/// macOS refuses, degrades to the plain opaque window instead of killing the
/// save.
pub fn apply(app: &AppHandle, opacity: u8) {
    let handle = app.clone();
    let opaque = opacity >= crate::vault::Settings::OPACITY_MAX;
    let work = move || {
        let Some(main) = handle.get_webview_window("main") else {
            return;
        };
        clear_vibrancy(&main).ok();
        if opaque {
            applog!("window vibrancy: off (opacity {opacity})");
            return;
        }
        // UnderWindowBackground is the material meant for exactly this — content
        // BEHIND the window showing through its background — and it is the least
        // tinted of the semantic set, so the desktop stays recognisable instead of
        // turning into a grey frost. `Active` rather than the default
        // follows-window-state: an unfocused window would otherwise flip to a flat
        // inactive wash, which reads as the feature breaking on every ⌘-tab.
        if let Err(e) = apply_vibrancy(
            &main,
            NSVisualEffectMaterial::UnderWindowBackground,
            Some(NSVisualEffectState::Active),
            None,
        ) {
            applog!("window vibrancy unavailable: {e}");
        } else {
            applog!("window vibrancy: UnderWindowBackground at opacity {opacity}");
        }
    };
    if let Err(e) = app.run_on_main_thread(work) {
        applog!("window vibrancy: main-thread hop failed: {e}");
    }
}
