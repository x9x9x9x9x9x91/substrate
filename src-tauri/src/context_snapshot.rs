//! What you were doing when you hit the capture hotkey.
//!
//! Behind the `experimental-context-capture` setting the capture window shows
//! a chip naming the app (and, when the system already lets us read it, the
//! document) that was frontmost at summon time, and files it as flat
//! `context-*` frontmatter. Off — the default — nothing here runs at all:
//! `arm_for_capture` returns before it touches a provider, so no Accessibility
//! call is made and no permission dialog can appear.
//!
//! The split is deliberate. Everything that decides *what a snapshot says*
//! lives in `snapshot` over a [`ContextProvider`], which tests drive with a
//! fake; everything that talks to AppKit lives in the macOS `sys` module,
//! which no test ever constructs. That is also the seam a later "capture from
//! anywhere" surface reuses: it arms the same slot through the same function.
//!
//! PERMISSIONS: the snapshot path only ever asks `AXIsProcessTrusted` — the
//! check that never prompts. The one place the Accessibility prompt may fire
//! is [`request_ax_access`], behind the explicit "Grant access…" button in
//! Settings → Experimental.

use std::sync::Mutex;

/// The frontmost app at summon time. `doc`/`file` are absent far more often
/// than not (no Accessibility trust, an app that exposes no document), and an
/// app name alone is still worth a chip.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct ContextSnapshot {
    /// `context-app` — display name of the frontmost application.
    pub app: String,
    /// `context-doc` — the focused window's document or title, as shown.
    pub doc: Option<String>,
    /// `context-file` — absolute path of the focused document, when the app
    /// exposes one (today: an Ableton Live set).
    pub file: Option<String>,
}

impl ContextSnapshot {
    /// Flat string props for `create_full`. Keys are lowercase and
    /// hyphenated like every other vault prop, and none of them collide with
    /// the engine-owned `created`/`type`/`title`.
    ///
    /// The capture window builds the same list itself (lib/capturecontext.ts)
    /// because it is the side that knows whether the chip was dropped, so this
    /// has no caller in the shipped binary — it is the parity reference the
    /// tests below hold that list to.
    #[allow(dead_code)]
    pub fn props(&self) -> Vec<(String, String)> {
        let mut out = vec![("context-app".to_string(), self.app.clone())];
        if let Some(doc) = self.doc.as_ref().filter(|s| !s.is_empty()) {
            out.push(("context-doc".to_string(), doc.clone()));
        }
        if let Some(file) = self.file.as_ref().filter(|s| !s.is_empty()) {
            out.push(("context-file".to_string(), file.clone()));
        }
        out
    }
}

/// The frontmost application, as the window server sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmost {
    pub name: String,
    pub pid: i32,
}

/// Everything the snapshot needs from the operating system. One trait so the
/// rules below can be tested without an AppKit process, a focused window, or
/// any Accessibility grant.
pub trait ContextProvider {
    fn frontmost(&self) -> Option<Frontmost>;
    /// `AXIsProcessTrusted` — the no-prompt check. False means every AX read
    /// below is skipped, not retried with a dialog.
    fn ax_trusted(&self) -> bool;
    /// `kAXDocumentAttribute` of the focused window: a `file://` URL for an
    /// app that has a file open, absent otherwise.
    fn focused_document(&self, pid: i32) -> Option<String>;
    /// `kAXTitleAttribute` of the focused window.
    fn focused_title(&self, pid: i32) -> Option<String>;
}

/// Our own product name (tauri.conf.json). Capturing while Substrate itself
/// is frontmost has nothing to say — the context would be the capture window.
pub const OWN_APP_NAME: &str = "Substrate";

/// Every shipping Live is "Ableton Live 12 Suite", "Ableton Live 11 Standard"
/// and so on, so the adapter matches on the stable prefix.
const ABLETON_PREFIX: &str = "Ableton Live";

/// The rules, in one place, over a provider.
///
/// Generic core: the app name always, the focused window's title as
/// `context-doc` when Accessibility is already trusted. Ableton adapter: the
/// open set's absolute `.als` path as `context-file`, falling back to the
/// project name parsed out of the window title when the document attribute is
/// unreadable or empty.
pub fn snapshot(p: &dyn ContextProvider) -> Option<ContextSnapshot> {
    let front = p.frontmost()?;
    let name = front.name.trim();
    if name.is_empty() || name.eq_ignore_ascii_case(OWN_APP_NAME) {
        return None;
    }
    let mut snap = ContextSnapshot {
        app: name.to_string(),
        ..Default::default()
    };
    if !p.ax_trusted() {
        // No trust, no reads: an app name is the whole snapshot.
        return Some(snap);
    }
    if name.starts_with(ABLETON_PREFIX) {
        snap.file = p
            .focused_document(front.pid)
            .as_deref()
            .and_then(document_path);
        if snap.file.is_none() {
            snap.doc = p
                .focused_title(front.pid)
                .as_deref()
                .and_then(ableton_project);
        }
    } else {
        snap.doc = p
            .focused_title(front.pid)
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
    }
    Some(snap)
}

/// Arm the pending slot for a capture window that is about to be shown.
///
/// The flag gate is here rather than at the call sites so there is exactly one
/// answer to "does the feature touch the system": with `enabled` false the
/// provider is never asked anything, and the slot is cleared so a snapshot
/// armed before the setting was turned off can't outlive it.
pub fn arm_for_capture(enabled: bool, p: &dyn ContextProvider, pending: &PendingContext) {
    if !enabled {
        pending.clear();
        return;
    }
    pending.set(snapshot(p));
}

/// `file:///Users/a/Music/My%20Track.als` → `/Users/a/Music/My Track.als`.
/// A plain path passes through; anything else (an `http` document, an empty
/// attribute) is not a file we can name.
fn document_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let path = if let Some(rest) = raw.strip_prefix("file://") {
        // The authority is empty on every local file URL AppKit hands out.
        percent_decode(rest.strip_prefix("localhost").unwrap_or(rest))
    } else if raw.starts_with('/') {
        raw.to_string()
    } else {
        return None;
    };
    (path.starts_with('/')).then_some(path)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = hex_pair(bytes[i + 1], bytes[i + 2]) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_pair(hi: u8, lo: u8) -> Option<u8> {
    let d = |c: u8| (c as char).to_digit(16).map(|n| n as u8);
    Some(d(hi)? << 4 | d(lo)?)
}

/// Live titles its window `"<Project> [<Set>] - Ableton Live 12 Suite"`. With
/// no document attribute to read, the project name is the honest part: the
/// suffix names the app (already `context-app`) and the bracket names the set
/// inside the project.
fn ableton_project(title: &str) -> Option<String> {
    let head = title
        .split(" - Ableton Live")
        .next()
        .unwrap_or("")
        .split(" — Ableton Live")
        .next()
        .unwrap_or("");
    let head = head.split(" [").next().unwrap_or("").trim();
    (!head.is_empty()).then(|| head.to_string())
}

/// The snapshot taken for the capture window that is currently open, if any.
///
/// Read non-consuming (the window resets itself more than once per summon,
/// same race the deeplink prefill documents) and dropped explicitly: on the
/// blur-hide, which runs no frontend code at all, and on the next summon.
#[derive(Default)]
pub struct PendingContext(Mutex<Option<ContextSnapshot>>);

impl PendingContext {
    pub fn set(&self, snap: Option<ContextSnapshot>) {
        *self.0.lock().unwrap() = snap;
    }
    pub fn get(&self) -> Option<ContextSnapshot> {
        self.0.lock().unwrap().clone()
    }
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

#[cfg(target_os = "macos")]
pub use sys::{ax_trusted, request_ax_access, system_provider};

/// Everywhere that isn't macOS there is no NSWorkspace and no Accessibility
/// API, so the provider answers nothing and the feature is inert by
/// construction.
#[cfg(not(target_os = "macos"))]
mod sys {
    use super::*;

    #[derive(Default)]
    pub struct SystemProvider;

    impl ContextProvider for SystemProvider {
        fn frontmost(&self) -> Option<Frontmost> {
            None
        }
        fn ax_trusted(&self) -> bool {
            false
        }
        fn focused_document(&self, _pid: i32) -> Option<String> {
            None
        }
        fn focused_title(&self, _pid: i32) -> Option<String> {
            None
        }
    }

    pub fn system_provider() -> SystemProvider {
        SystemProvider
    }
    pub fn ax_trusted() -> bool {
        false
    }
    pub fn request_ax_access() -> bool {
        false
    }
}

#[cfg(not(target_os = "macos"))]
pub use sys::{ax_trusted, request_ax_access, system_provider};

#[cfg(target_os = "macos")]
mod sys {
    //! The AppKit/Accessibility half. objc2 message sends, in the same style
    //! panel.rs and dragfix.rs already use — no new crate for three classes
    //! and four C functions.

    use super::{ContextProvider, Frontmost};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use std::ffi::{c_void, CStr, CString};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// The check that NEVER prompts. Everything on the snapshot path uses
        /// this one.
        fn AXIsProcessTrusted() -> bool;
        /// The check that CAN prompt, depending on the options dictionary.
        /// One caller only: the Settings button.
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
        fn AXUIElementCopyAttributeValue(
            element: *mut c_void,
            attribute: *const c_void,
            value: *mut *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        // `CFTypeRef` is `const void *`, and the OCR module declares this same
        // symbol the same way. Two declarations of one extern function that
        // disagree about their argument warn on every build, so they match.
        fn CFRelease(cf: *const c_void);
    }

    /// `kAXFocusedWindowAttribute` / `kAXDocumentAttribute` /
    /// `kAXTitleAttribute`. Their values, not the exported CFString globals:
    /// an NSString is toll-free bridged to the CFStringRef the API wants, and
    /// this avoids linking three symbols to build three literals.
    const AX_FOCUSED_WINDOW: &str = "AXFocusedWindow";
    const AX_DOCUMENT: &str = "AXDocument";
    const AX_TITLE: &str = "AXTitle";
    /// `kAXTrustedCheckOptionPrompt`, same reasoning.
    const AX_PROMPT_OPTION: &str = "AXTrustedCheckOptionPrompt";

    /// An autoreleased NSString. Null when the text can't be a C string
    /// (an interior NUL), which every caller treats as "no answer".
    unsafe fn ns_string(s: &str) -> *mut AnyObject {
        let Some(cls) = AnyClass::get(c"NSString") else {
            return std::ptr::null_mut();
        };
        let Ok(c) = CString::new(s) else {
            return std::ptr::null_mut();
        };
        msg_send![cls, stringWithUTF8String: c.as_ptr()]
    }

    /// Read an NSString (or the toll-free bridged CFString an AX attribute
    /// returns) back into Rust.
    unsafe fn ns_to_string(obj: *mut AnyObject) -> Option<String> {
        if obj.is_null() {
            return None;
        }
        let ptr: *const std::ffi::c_char = msg_send![obj, UTF8String];
        if ptr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }

    /// One AX attribute of one element, as a string. `None` for every
    /// failure the API has — untrusted, no such attribute, wrong type.
    unsafe fn ax_string(element: *mut c_void, attribute: &str) -> Option<String> {
        let value = ax_value(element, attribute)?;
        let out = ns_to_string(value as *mut AnyObject);
        CFRelease(value);
        out
    }

    /// One AX attribute as a raw CFTypeRef the caller must release.
    unsafe fn ax_value(element: *mut c_void, attribute: &str) -> Option<*mut c_void> {
        let attr = ns_string(attribute);
        if attr.is_null() {
            return None;
        }
        let mut out: *mut c_void = std::ptr::null_mut();
        let err = AXUIElementCopyAttributeValue(element, attr as *const c_void, &mut out);
        if err != 0 || out.is_null() {
            return None;
        }
        Some(out)
    }

    /// The focused window of an app, or None — including the ordinary case of
    /// an app whose only window is a menu bar extra.
    unsafe fn focused_window(pid: i32) -> Option<*mut c_void> {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        let win = ax_value(app, AX_FOCUSED_WINDOW);
        CFRelease(app);
        win
    }

    unsafe fn window_string(pid: i32, attribute: &str) -> Option<String> {
        let win = focused_window(pid)?;
        let out = ax_string(win, attribute);
        CFRelease(win);
        out.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    #[derive(Default)]
    pub struct SystemProvider;

    impl ContextProvider for SystemProvider {
        /// NSWorkspace's frontmost application. No permission of any kind:
        /// the app name and pid are public to every process.
        fn frontmost(&self) -> Option<Frontmost> {
            unsafe {
                let cls = AnyClass::get(c"NSWorkspace")?;
                let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
                if ws.is_null() {
                    return None;
                }
                let app: *mut AnyObject = msg_send![ws, frontmostApplication];
                if app.is_null() {
                    return None;
                }
                let name_obj: *mut AnyObject = msg_send![app, localizedName];
                let name = ns_to_string(name_obj)?;
                let pid: i32 = msg_send![app, processIdentifier];
                Some(Frontmost { name, pid })
            }
        }

        fn ax_trusted(&self) -> bool {
            unsafe { AXIsProcessTrusted() }
        }

        fn focused_document(&self, pid: i32) -> Option<String> {
            unsafe { window_string(pid, AX_DOCUMENT) }
        }

        fn focused_title(&self, pid: i32) -> Option<String> {
            unsafe { window_string(pid, AX_TITLE) }
        }
    }

    pub fn system_provider() -> SystemProvider {
        SystemProvider
    }

    /// The no-prompt trust check, for the Settings row's own label.
    pub fn ax_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// THE ONLY PLACE THE ACCESSIBILITY PROMPT MAY FIRE. Called from the
    /// "Grant access…" button in Settings → Experimental and nowhere else.
    /// Returns the trust state as it stands after asking — false while the
    /// user is still looking at the System Settings pane macOS opens.
    pub fn request_ax_access() -> bool {
        unsafe {
            let (Some(dict_cls), Some(num_cls)) =
                (AnyClass::get(c"NSDictionary"), AnyClass::get(c"NSNumber"))
            else {
                return AXIsProcessTrusted();
            };
            let key = ns_string(AX_PROMPT_OPTION);
            let yes: *mut AnyObject = msg_send![num_cls, numberWithBool: true];
            if key.is_null() || yes.is_null() {
                return AXIsProcessTrusted();
            }
            let options: *mut AnyObject =
                msg_send![dict_cls, dictionaryWithObject: yes, forKey: key];
            if options.is_null() {
                return AXIsProcessTrusted();
            }
            AXIsProcessTrustedWithOptions(options as *const c_void)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A provider that answers from fixture data and counts every question.
    /// Nothing here touches AppKit, so `cargo test` can never raise a
    /// permission dialog.
    #[derive(Default)]
    struct Fake {
        front: Option<Frontmost>,
        trusted: bool,
        document: Option<String>,
        title: Option<String>,
        asked: Cell<usize>,
    }

    impl Fake {
        fn app(name: &str) -> Self {
            Fake {
                front: Some(Frontmost {
                    name: name.into(),
                    pid: 42,
                }),
                ..Default::default()
            }
        }
        fn trusted(mut self) -> Self {
            self.trusted = true;
            self
        }
        fn document(mut self, d: &str) -> Self {
            self.document = Some(d.into());
            self
        }
        fn title(mut self, t: &str) -> Self {
            self.title = Some(t.into());
            self
        }
    }

    impl ContextProvider for Fake {
        fn frontmost(&self) -> Option<Frontmost> {
            self.asked.set(self.asked.get() + 1);
            self.front.clone()
        }
        fn ax_trusted(&self) -> bool {
            self.asked.set(self.asked.get() + 1);
            self.trusted
        }
        fn focused_document(&self, _pid: i32) -> Option<String> {
            self.asked.set(self.asked.get() + 1);
            self.document.clone()
        }
        fn focused_title(&self, _pid: i32) -> Option<String> {
            self.asked.set(self.asked.get() + 1);
            self.title.clone()
        }
    }

    #[test]
    fn frontmost_app_alone_is_a_snapshot() {
        let snap = snapshot(&Fake::app("Safari")).unwrap();
        assert_eq!(snap.app, "Safari");
        assert_eq!(snap.doc, None);
        assert_eq!(snap.file, None);
        assert_eq!(
            snap.props(),
            vec![("context-app".to_string(), "Safari".to_string())]
        );
    }

    #[test]
    fn a_trusted_read_adds_the_window_title() {
        let snap = snapshot(&Fake::app("Safari").trusted().title("  Hyperdub — Releases  ")).unwrap();
        assert_eq!(snap.doc.as_deref(), Some("Hyperdub — Releases"));
        assert_eq!(snap.file, None);
    }

    #[test]
    fn capturing_from_substrate_itself_snapshots_nothing() {
        assert_eq!(snapshot(&Fake::app("Substrate").trusted().title("Inbox")), None);
        assert_eq!(snapshot(&Fake::default()), None);
        assert_eq!(snapshot(&Fake::app("   ")), None);
    }

    #[test]
    fn ableton_with_accessibility_resolves_the_als_path() {
        let snap = snapshot(
            &Fake::app("Ableton Live 12 Suite")
                .trusted()
                .document("file:///Users/a/Music/My%20Track/My%20Track.als")
                .title("My Track [Set 3] - Ableton Live 12 Suite"),
        )
        .unwrap();
        assert_eq!(
            snap.file.as_deref(),
            Some("/Users/a/Music/My Track/My Track.als")
        );
        // the path already says it; the title would only repeat the app name
        assert_eq!(snap.doc, None);
        assert_eq!(
            snap.props(),
            vec![
                ("context-app".to_string(), "Ableton Live 12 Suite".to_string()),
                (
                    "context-file".to_string(),
                    "/Users/a/Music/My Track/My Track.als".to_string()
                ),
            ]
        );
    }

    #[test]
    fn ableton_without_a_document_falls_back_to_the_project_name() {
        let snap = snapshot(
            &Fake::app("Ableton Live 12 Suite")
                .trusted()
                .title("My Track [Set 3] - Ableton Live 12 Suite"),
        )
        .unwrap();
        assert_eq!(snap.file, None);
        assert_eq!(snap.doc.as_deref(), Some("My Track"));
    }

    #[test]
    fn ableton_without_accessibility_is_the_app_name_alone() {
        let snap = snapshot(&Fake::app("Ableton Live 11 Standard")).unwrap();
        assert_eq!(snap.app, "Ableton Live 11 Standard");
        assert_eq!(snap.doc, None);
        assert_eq!(snap.file, None);
    }

    #[test]
    fn a_document_that_is_not_a_file_is_not_a_path() {
        let snap = snapshot(
            &Fake::app("Ableton Live 12 Suite")
                .trusted()
                .document("https://example.com/set")
                .title("Untitled - Ableton Live 12 Suite"),
        )
        .unwrap();
        assert_eq!(snap.file, None);
        assert_eq!(snap.doc.as_deref(), Some("Untitled"));
    }

    /// The inertness contract: flag off means the provider is never asked a
    /// single question — no NSWorkspace call, no `AXIsProcessTrusted`, and so
    /// no possibility of a permission prompt.
    #[test]
    fn the_flag_off_asks_the_system_nothing() {
        let fake = Fake::app("Ableton Live 12 Suite").trusted().title("My Track");
        let pending = PendingContext::default();
        pending.set(Some(ContextSnapshot {
            app: "stale".into(),
            ..Default::default()
        }));
        arm_for_capture(false, &fake, &pending);
        assert_eq!(fake.asked.get(), 0);
        // …and a snapshot armed while the flag was on does not survive it
        assert_eq!(pending.get(), None);
    }

    #[test]
    fn arming_stores_the_snapshot_and_hiding_drops_it() {
        let fake = Fake::app("Safari");
        let pending = PendingContext::default();
        arm_for_capture(true, &fake, &pending);
        assert_eq!(pending.get().unwrap().app, "Safari");
        pending.clear();
        assert_eq!(pending.get(), None);
    }
}
