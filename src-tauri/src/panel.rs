//! Turn the tray agenda popover into a non-activating panel.
//!
//! A menu-bar extra must not activate its app. tao builds every window as a
//! `TaoWindow` (an `NSWindow` subclass), and an ordinary `NSWindow` can only
//! become key while its application is active — which is why showing the
//! popover used to raise the whole Substrate app behind it. AppKit's answer
//! is `NSPanel` with `NSWindowStyleMaskNonactivatingPanel`: it takes key
//! status, and therefore keystrokes (Escape dismisses), without activating
//! the app.
//!
//! Tao gives no way to pick the window class, so the class is swapped after
//! construction — the same trick `tauri-nspanel` uses. `object_setClass` is
//! only sound when the replacement is layout-compatible with the original:
//! same instance size, and any inherited ivar at the same offset. `NSPanel`
//! is a direct `NSWindow` subclass that adds no storage of its own, so a
//! subclass of it carrying tao's one `focusable` ivar lays out identically —
//! `install` verifies both facts at runtime and refuses the swap if a future
//! AppKit or tao breaks the assumption, leaving today's (activating, but
//! working) behavior.
//!
//! `canBecomeMainWindow` returns NO so the panel never becomes the app's main
//! window; `canBecomeKeyWindow` returns YES unconditionally, replacing tao's
//! `focusable`-ivar read, because a popover that cannot take keys cannot be
//! dismissed with Escape.

use std::ffi::c_void;
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};

/// `NSWindowStyleMaskNonactivatingPanel` — the whole point of the exercise.
const NONACTIVATING_PANEL: usize = 1 << 7;
/// `NSWindowCollectionBehaviorCanJoinAllSpaces`: a menu-bar popover belongs to
/// whichever space the user is looking at, not the one it was built on.
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
/// `NSWindowCollectionBehaviorFullScreenAuxiliary`: … including over another
/// app's full-screen space, where the menu bar (and so the tray icon) lives.
const FULL_SCREEN_AUXILIARY: usize = 1 << 8;

/// tao's own ivar (`platform_impl/macos/window.rs`), read by its
/// `canBecomeKeyWindow`/`canBecomeMainWindow` and written by
/// `set_focusable`. Carried on the replacement class purely so the memory
/// layout matches; our method overrides mean nothing reads it anymore.
const FOCUSABLE_IVAR: &std::ffi::CStr = c"focusable";

/// Name of the class we register. Also the idempotency check: an already
/// converted window reports it as its class name.
const PANEL_CLASS: &std::ffi::CStr = c"SubstrateNonactivatingPanel";

type BoolImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool;

unsafe extern "C-unwind" fn yes(_this: *mut AnyObject, _sel: Sel) -> Bool {
    Bool::YES
}

unsafe extern "C-unwind" fn no(_this: *mut AnyObject, _sel: Sel) -> Bool {
    Bool::NO
}

/// `&'static AnyClass` is a plain pointer into the Objective-C runtime's own
/// tables; sharing it across threads is what every `class!()` call already
/// does. The newtype is only here to say so to `OnceLock`.
struct PanelClass(Option<&'static AnyClass>);
unsafe impl Send for PanelClass {}
unsafe impl Sync for PanelClass {}

/// Register (once) the `NSPanel` subclass windows are re-classed into.
fn panel_class() -> Option<&'static AnyClass> {
    static CLS: OnceLock<PanelClass> = OnceLock::new();
    CLS.get_or_init(|| {
        PanelClass((|| {
            // already registered (a second app instance in-process, or a
            // rebuilt window) — reuse it rather than failing the builder
            if let Some(existing) = AnyClass::get(PANEL_CLASS) {
                return Some(existing);
            }
            let nspanel = AnyClass::get(c"NSPanel")?;
            let mut builder = ClassBuilder::new(PANEL_CLASS, nspanel)?;
            unsafe {
                builder.add_method(sel!(canBecomeKeyWindow), yes as BoolImp);
                builder.add_method(sel!(canBecomeMainWindow), no as BoolImp);
            }
            builder.add_ivar::<Bool>(FOCUSABLE_IVAR);
            Some(builder.register())
        })())
    })
    .0
}

/// Is `cls` layout-compatible with `target` — same instance size, and the
/// `focusable` ivar (if either has one) at the same offset?
fn layout_matches(cls: &AnyClass, target: &AnyClass) -> bool {
    if cls.instance_size() != target.instance_size() {
        return false;
    }
    let a = cls.instance_variable(FOCUSABLE_IVAR).map(|i| i.offset());
    let b = target.instance_variable(FOCUSABLE_IVAR).map(|i| i.offset());
    a == b
}

/// Convert a tao-built `NSWindow` into a non-activating panel. Returns false
/// (having changed nothing) when the runtime shape isn't what's expected.
///
/// # Safety
/// Must be called on the main thread with a live `NSWindow` pointer, before
/// the window is first shown.
pub unsafe fn install(ns_window: *mut c_void) -> bool {
    if ns_window.is_null() {
        return false;
    }
    let obj = unsafe { &*ns_window.cast::<AnyObject>() };
    let current = obj.class();
    // idempotent: converting twice would re-OR the style mask harmlessly, but
    // saying so plainly is cheaper than reasoning about it
    if current.name() == PANEL_CLASS {
        return true;
    }
    let Some(panel) = panel_class() else {
        return false;
    };
    if !layout_matches(current, panel) {
        return false;
    }
    unsafe {
        AnyObject::set_class(obj, panel);
        let mask: usize = msg_send![obj, styleMask];
        let _: () = msg_send![obj, setStyleMask: mask | NONACTIVATING_PANEL];
        // key on click (so Escape reaches the webview), and no auto-hide —
        // the app hides the popover itself on the Focused(false) event
        let _: () = msg_send![obj, setBecomesKeyOnlyIfNeeded: Bool::NO];
        let _: () = msg_send![obj, setHidesOnDeactivate: Bool::NO];
        let _: () = msg_send![obj, setFloatingPanel: Bool::YES];
        let behavior: usize = msg_send![obj, collectionBehavior];
        let _: () = msg_send![
            obj,
            setCollectionBehavior: behavior | CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY
        ];
    }
    true
}

/// Take key status without activating the app — the panel replacement for
/// tao's `set_focus`, which ends in `activateIgnoringOtherApps:`.
///
/// # Safety
/// Main thread, live `NSWindow` pointer.
pub unsafe fn make_key(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    let obj = unsafe { &*ns_window.cast::<AnyObject>() };
    unsafe {
        let _: () = msg_send![obj, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The soundness precondition of the class swap, checked against the real
    /// AppKit this build links: a subclass of `NSPanel` carrying tao's ivar
    /// must lay out exactly like a subclass of `NSWindow` carrying it. If
    /// AppKit ever gives `NSPanel` storage of its own this fails here rather
    /// than corrupting a live window.
    #[test]
    fn panel_subclass_is_layout_compatible_with_a_window_subclass() {
        let nswindow = AnyClass::get(c"NSWindow").expect("NSWindow");
        let mut probe = ClassBuilder::new(c"SubstratePanelLayoutProbe", nswindow)
            .expect("class registered twice — test re-run in one process?");
        probe.add_ivar::<Bool>(FOCUSABLE_IVAR);
        let probe = probe.register();

        let panel = panel_class().expect("NSPanel subclass");
        assert!(
            layout_matches(probe, panel),
            "NSPanel subclass ({} bytes) is not layout-compatible with an \
             NSWindow subclass ({} bytes) — install() must refuse the swap",
            panel.instance_size(),
            probe.instance_size(),
        );
    }
}
