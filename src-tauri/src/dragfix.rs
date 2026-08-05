//! SUB-614: hand the webview's OWN drags back to WebKit.
//!
//! wry's `WryWebView` overrides the four `NSDraggingDestination` methods and
//! tauri-runtime-wry's handler claims EVERY drag session ("handled"), so
//! WebKit never sees the drop — HTML5 drag-and-drop (sidebar reorder,
//! note→folder, board columns, key chips, calendar reschedule) silently dies
//! in the real app while passing every Chromium gate. The overrides exist for
//! one job: Finder/cross-app file drops. An internal drag — one whose
//! `draggingSource` is a view inside this webview — never needs them.
//!
//! So: swizzle each override to fork on the session's source. Internal drags
//! call straight through to `WKWebView`'s implementation (the normal DOM
//! drag-and-drop pipeline, exactly what Safari does); external drags keep
//! wry's untouched file-drop lane (`onDragDropEvent` with real paths —
//! SUB-414 drop positioning and SUB-438 ⇧-link-in-place depend on those).
//!
//! Swizzling is class-level, so one install covers every window's webview;
//! the internal/external fork reads the receiving instance, so each webview
//! still only claims its own sessions. External sessions always report a nil
//! `draggingSource` in the destination app (AppKit contract), which keeps the
//! fork honest: a drag from another app can never look internal.

use std::sync::Once;

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};

/// `draggingEntered:` / `draggingUpdated:` — NSDragOperation is NSUInteger.
type EnterImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
type PerformImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;
type ExitImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

struct Table {
    wry_entered: EnterImp,
    wry_updated: EnterImp,
    wry_perform: PerformImp,
    wry_exited: ExitImp,
    wk_entered: EnterImp,
    wk_updated: EnterImp,
    wk_perform: PerformImp,
    wk_exited: ExitImp,
}

// Written exactly once by `install` BEFORE any method is swizzled; the
// swizzled IMPs (the only readers) can therefore never observe None.
static mut TABLE: Option<Table> = None;
static INSTALL: Once = Once::new();

fn table() -> &'static Table {
    // SAFETY: `install` wrote TABLE before swapping any IMP in, and nothing
    // writes it afterwards.
    unsafe {
        #[allow(static_mut_refs)]
        TABLE.as_ref().expect("dragfix IMP ran before install")
    }
}

/// Both IMPs of a selector — the subclass's own override and the
/// superclass's inherited pipeline — or None unless BOTH exist and differ.
///
/// The distinctness check is the fail-safe's linchpin (SUB-623):
/// `instance_method` is `class_getInstanceMethod`, which searches
/// superclasses. If a future wry keeps the class name but drops its drag
/// overrides, both lookups resolve to the same inherited Method; swizzling
/// it would mutate WKWebView itself, and the "wry" branch of the fork would
/// re-enter the swizzled fn — unbounded recursion. Distinct IMPs are the
/// proof the subclass really owns its override.
fn owned_pair(cls: &AnyClass, sup: &AnyClass, sel: Sel) -> Option<(Imp, Imp)> {
    let own = cls.instance_method(sel)?.implementation();
    let inherited = sup.instance_method(sel)?.implementation();
    // fn_addr_eq over `!=`: the whole guard is an address comparison, so use
    // the form that says so (and silences unpredictable_function_pointer_
    // comparisons). A false "equal" (ICF folding two identical fns) only
    // makes the guard MORE conservative — it refuses to swizzle.
    (!std::ptr::fn_addr_eq(own, inherited)).then_some((own, inherited))
}

/// Did the webview start this drag session itself?
unsafe fn internal(this: *mut AnyObject, info: *mut AnyObject) -> bool {
    if this.is_null() || info.is_null() {
        return false;
    }
    let src: *mut AnyObject = msg_send![&*info, draggingSource];
    if src.is_null() {
        return false;
    }
    let Some(nsview) = AnyClass::get(c"NSView") else {
        return false;
    };
    let is_view: bool = msg_send![&*src, isKindOfClass: nsview];
    if !is_view {
        return false;
    }
    // "is src the receiver or one of its subviews" — WebKit names the
    // WKWebView itself as the source of DOM-initiated sessions.
    msg_send![&*src, isDescendantOf: &*this]
}

/// `SUBSTRATE_DRAGFIX_DEBUG=1` traces every fork decision to stderr.
fn debug() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("SUBSTRATE_DRAGFIX_DEBUG").is_ok())
}

unsafe extern "C-unwind" fn entered(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) -> usize {
    let t = table();
    if unsafe { internal(this, info) } {
        if debug() {
            eprintln!("dragfix: entered → internal (WebKit)");
        }
        unsafe { (t.wk_entered)(this, sel, info) }
    } else {
        if debug() {
            eprintln!("dragfix: entered → external (wry)");
        }
        unsafe { (t.wry_entered)(this, sel, info) }
    }
}

unsafe extern "C-unwind" fn updated(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) -> usize {
    let t = table();
    if unsafe { internal(this, info) } {
        unsafe { (t.wk_updated)(this, sel, info) }
    } else {
        unsafe { (t.wry_updated)(this, sel, info) }
    }
}

unsafe extern "C-unwind" fn perform(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) -> Bool {
    let t = table();
    if unsafe { internal(this, info) } {
        unsafe { (t.wk_perform)(this, sel, info) }
    } else {
        unsafe { (t.wry_perform)(this, sel, info) }
    }
}

unsafe extern "C-unwind" fn exited(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) {
    let t = table();
    if unsafe { internal(this, info) } {
        unsafe { (t.wk_exited)(this, sel, info) }
    } else {
        unsafe { (t.wry_exited)(this, sel, info) }
    }
}

/// Swizzle the drag-destination methods on the webview's class. `webview` is
/// the raw WKWebView-subclass pointer from `PlatformWebview::inner()`. Runs
/// once per process; later calls (more windows) are no-ops. If any lookup
/// comes back empty — a wry upgrade reshaping the class — nothing is
/// swizzled and the app keeps today's (drag-dead but safe) behavior.
///
/// # Safety
/// Must be called on the main thread with a live webview pointer
/// (`with_webview` guarantees both).
pub unsafe fn install(webview: *mut std::ffi::c_void) {
    if webview.is_null() {
        return;
    }
    INSTALL.call_once(|| {
        let obj = webview.cast::<AnyObject>();
        // The instance's dynamic class is usually a KVO shim
        // (`NSKVONotifying_…WryWebView…`) whose superclass is WryWebView.
        // The walk anchors on names: `wry_cls` takes the FIRST name match —
        // possibly the shim itself, which is fine because `instance_method`
        // resolves through it to WryWebView's real Method (KVO only
        // synthesizes setters) and `set_implementation` mutates that — and
        // `wk_cls` the exact "WKWebView" further up (the WebKit pipeline the
        // overrides shadow). Unrecognizable names → both stay None → bail.
        let start = unsafe { (*obj).class() };
        let mut wry_cls = None;
        let mut wk_cls = None;
        let mut walk = Some(start);
        while let Some(c) = walk {
            let name = c.name().to_string_lossy();
            if wry_cls.is_none() && name.contains("WryWebView") {
                wry_cls = Some(c);
            }
            if name == "WKWebView" {
                wk_cls = Some(c);
                break;
            }
            walk = c.superclass();
        }
        let (Some(cls), Some(sup)) = (wry_cls, wk_cls) else {
            if debug() {
                eprintln!(
                    "dragfix: class walk from {:?} found no WryWebView/WKWebView — not swizzling",
                    start.name()
                );
            }
            return;
        };
        if debug() {
            eprintln!("dragfix: installing on {:?} → {:?}", cls.name(), sup.name());
        }
        let sels = (
            sel!(draggingEntered:),
            sel!(draggingUpdated:),
            sel!(performDragOperation:),
            sel!(draggingExited:),
        );
        // wry's overrides live ON the class; WKWebView's own drag pipeline is
        // reached through the superclass lookup (same route wry's reject path
        // takes). Any hole → bail without swizzling.
        let found = (
            owned_pair(cls, sup, sels.0),
            owned_pair(cls, sup, sels.1),
            owned_pair(cls, sup, sels.2),
            owned_pair(cls, sup, sels.3),
        );
        let (
            Some((wry_entered, wk_entered)),
            Some((wry_updated, wk_updated)),
            Some((wry_perform, wk_perform)),
            Some((wry_exited, wk_exited)),
        ) = found
        else {
            if debug() {
                eprintln!("dragfix: drag methods missing or no longer overridden — not swizzling");
            }
            return;
        };
        unsafe {
            #[allow(static_mut_refs)]
            {
                TABLE = Some(Table {
                    wry_entered: std::mem::transmute::<Imp, EnterImp>(wry_entered),
                    wry_updated: std::mem::transmute::<Imp, EnterImp>(wry_updated),
                    wry_perform: std::mem::transmute::<Imp, PerformImp>(wry_perform),
                    wry_exited: std::mem::transmute::<Imp, ExitImp>(wry_exited),
                    wk_entered: std::mem::transmute::<Imp, EnterImp>(wk_entered),
                    wk_updated: std::mem::transmute::<Imp, EnterImp>(wk_updated),
                    wk_perform: std::mem::transmute::<Imp, PerformImp>(wk_perform),
                    wk_exited: std::mem::transmute::<Imp, ExitImp>(wk_exited),
                });
            }
            // TABLE is visible before any IMP swaps in (same thread installs,
            // AppKit delivers drags on this thread too).
            let set = |s: Sel, f: Imp| {
                if let Some(m) = cls.instance_method(s) {
                    m.set_implementation(f);
                }
            };
            set(sels.0, std::mem::transmute::<EnterImp, Imp>(entered as EnterImp));
            set(sels.1, std::mem::transmute::<EnterImp, Imp>(updated as EnterImp));
            set(sels.2, std::mem::transmute::<PerformImp, Imp>(perform as PerformImp));
            set(sels.3, std::mem::transmute::<ExitImp, Imp>(exited as ExitImp));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::{ClassBuilder, NSObject};
    use objc2::ClassType;

    /// A base class and a subclass that overrides `draggingEntered:` but NOT
    /// `draggingUpdated:` — the same shape as a wry that dropped an
    /// override. `owned_pair` must hand back distinct IMPs for the override
    /// and refuse the inherited one (the SUB-623 recursion hole).
    ///
    /// Scope honestly stated: this pins `owned_pair`'s LOGIC on synthetic
    /// classes. It does not observe the real WryWebView (registered lazily,
    /// only once a webview exists — unreachable from a unit test), so a wry
    /// bump that drops overrides still degrades at runtime: silently drag-
    /// dead, diagnosed via SUBSTRATE_DRAGFIX_DEBUG (docs/smoke.md) — but no
    /// longer recursing, which is what this guard is for.
    #[test]
    fn owned_pair_rejects_inherited_methods() {
        unsafe extern "C-unwind" fn base_imp(
            _this: *mut AnyObject,
            _sel: Sel,
            _info: *mut AnyObject,
        ) -> usize {
            1
        }
        unsafe extern "C-unwind" fn sub_imp(
            _this: *mut AnyObject,
            _sel: Sel,
            _info: *mut AnyObject,
        ) -> usize {
            2
        }

        let entered = sel!(draggingEntered:);
        let updated = sel!(draggingUpdated:);

        let mut base = ClassBuilder::new(c"DragfixTestBase", NSObject::class())
            .expect("class registered twice — test re-run in one process?");
        unsafe {
            base.add_method(entered, base_imp as EnterImp);
            base.add_method(updated, base_imp as EnterImp);
        }
        let base = base.register();

        let mut sub = ClassBuilder::new(c"DragfixTestSub", base).unwrap();
        unsafe {
            sub.add_method(entered, sub_imp as EnterImp);
            // draggingUpdated: deliberately NOT overridden
        }
        let sub = sub.register();

        // the real override: both IMPs found, and they differ
        let (own, inherited) = owned_pair(sub, base, entered).expect("override not detected");
        assert!(!std::ptr::fn_addr_eq(own, inherited));

        // the inherited method: class_getInstanceMethod finds it on BOTH
        // lookups (superclass search), but the IMPs are identical — this is
        // the case that must refuse to swizzle
        assert!(owned_pair(sub, base, updated).is_none());

        // a selector neither implements
        assert!(owned_pair(sub, base, sel!(performDragOperation:)).is_none());
    }
}
