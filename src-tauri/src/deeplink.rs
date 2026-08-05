//! `substrate://` deeplinks (SUB-1075) — the OS-level door into a running or
//! cold app: `substrate://note/<vault-relative path>.md` opens a note,
//! `substrate://capture?text=…` opens quick capture prefilled.
//!
//! This is a different mechanism from `kinds.rs`'s `substrate-kind:` handler:
//! that one serves bytes *inside* the webview via `register_uri_scheme_protocol`
//! and is invisible to the OS. This one is registered with the OS (Info.plist
//! `CFBundleURLTypes` on macOS, the registry on Windows, a .desktop entry on
//! Linux — all generated from `plugins.deep-link.desktop` in tauri.conf.json),
//! so anything on the machine can hand us a URL. A hostile URL is one click
//! away by design, which is why `parse` refuses everything it cannot prove
//! safe *before* anything is opened, and why the note route resolves through
//! the vault index rather than touching a path the link named.
//!
//! Ordering is the other hazard. A cold start delivers the URL while the
//! frontend is still booting and the vault may not be loaded, so nothing is
//! resolved at arrival: links queue, and the main window drains the queue
//! (`deeplink_take_pending`) once it is mounted — which is also the moment the
//! engine is guaranteed usable. A warm link nudges the same drain with
//! `deeplink:pending`, so there is exactly one resolution site either way.

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use url::Url;

use crate::kinds::percent_decode;

/// The OS-registered scheme. Mirrors `plugins.deep-link.desktop.schemes` in
/// tauri.conf.json — the config is what actually registers it; this constant
/// is what we check arriving URLs against.
pub(crate) const SCHEME: &str = "substrate";

/// A prefill is a link parameter, so it is attacker-controlled length as much
/// as content. Capture is a one-line box; anything past this is not a note
/// somebody meant to type.
const MAX_PREFILL: usize = 4096;

/// What a well-formed `substrate://` URL asks for. Nothing here has been
/// checked against the vault yet — `OpenNote`'s path is syntactically safe
/// (relative, no traversal, `.md`), not known to exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    OpenNote(String),
    Capture { text: Option<String> },
}

/// Parse and validate a `substrate://` URL. Every rejection is a message the
/// user sees, because "the link did nothing" is the one outcome SUB-1075 rules
/// out.
pub(crate) fn parse(raw: &str) -> Result<Action, String> {
    let url = Url::parse(raw).map_err(|_| format!("Not a valid link: {raw}"))?;
    if !url.scheme().eq_ignore_ascii_case(SCHEME) {
        return Err(format!("Not a Substrate link: {raw}"));
    }
    // `Url::parse` resolves `..` while parsing, so `substrate://note/../../x.md`
    // reaches us as the perfectly innocent `/x.md`. That is not an escape (the
    // result is still vault-relative), but a link that ASKED to climb out is
    // not one to quietly honour under a different meaning — catch it on the
    // raw text before the parser launders it. Query and fragment come off
    // first so a capture prefill mentioning `..` isn't read as traversal.
    // `%2e%2e` counts as a dot segment to the URL spec, so this decodes each
    // segment before comparing — a whole-segment `..` in any spelling.
    let path_part = raw.split(['?', '#']).next().unwrap_or(raw);
    if path_part
        .split('/')
        .any(|s| percent_decode(s).as_deref() == Some(".."))
    {
        return Err(format!("Refused an unsafe Substrate link: {raw}"));
    }
    // `substrate://note/a.md` parses with host `note` and path `/a.md`;
    // `substrate:note/a.md` (no authority) is a cannot-be-a-base URL whose
    // whole path is `note/a.md`. Both shapes turn up in the wild — Terminal
    // `open`, HTML anchors, other apps' link builders — so normalise to
    // route + remainder here rather than trusting one spelling.
    // exactly one leading slash comes off — `//etc/passwd.md` must stay
    // absolute (an empty first segment) rather than being scrubbed relative
    let strip_one = |p: &str| p.strip_prefix('/').unwrap_or(p).to_string();
    let (route, rest) = match url.host_str() {
        Some(h) => (h.to_string(), strip_one(url.path())),
        None => {
            let p = strip_one(url.path());
            match p.split_once('/') {
                Some((r, rest)) => (r.to_string(), rest.to_string()),
                None => (p.to_string(), String::new()),
            }
        }
    };
    match route.to_ascii_lowercase().as_str() {
        "note" => Ok(Action::OpenNote(note_path(&rest)?)),
        "capture" => Ok(Action::Capture {
            text: capture_text(&url),
        }),
        "" => Err(format!("Substrate link with nothing to open: {raw}")),
        other => Err(format!("Substrate doesn't know how to open “{other}” links.")),
    }
}

/// Validate the note route's path. Percent-decoding happens **before** every
/// check, so `%2e%2e%2f` is refused as the `../` it is instead of sliding
/// through as opaque text (the same rule kinds.rs works under).
fn note_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("A substrate://note/… link needs a note path.".into());
    }
    let unsafe_path = || format!("Refused an unsafe note link: {raw}");
    let mut segs: Vec<String> = Vec::new();
    for seg in raw.split('/') {
        let seg = percent_decode(seg).ok_or_else(|| format!("Bad escape in note link: {raw}"))?;
        // empty rejects `//` and a trailing slash; `.`/`..` reject traversal;
        // a decoded separator or control char means the link tried to smuggle
        // structure through a single segment. An absolute path can't survive
        // this loop — a leading `/` is an empty first segment.
        if seg.is_empty()
            || seg == "."
            || seg == ".."
            || seg.contains('/')
            || seg.contains('\\')
            || seg.chars().any(char::is_control)
        {
            return Err(unsafe_path());
        }
        segs.push(seg);
    }
    let rel = segs.join("/");
    if !rel.ends_with(".md") {
        return Err(format!("Substrate links open .md notes — “{rel}” isn't one."));
    }
    Ok(rel)
}

/// `?text=` prefill for the capture route, trimmed and capped. Absent, blank
/// and oversized all collapse to "open capture empty" rather than an error:
/// the user asked for the capture box, and they get it.
fn capture_text(url: &Url) -> Option<String> {
    let raw = url
        .query_pairs()
        .find(|(k, _)| k == "text")
        .map(|(_, v)| v.into_owned())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_PREFILL).collect())
}

// ---------- pending state ----------

/// One drained link, as the frontend sees it: either a note to open or a
/// message to show. Exactly one field is set.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct Resolved {
    pub(crate) path: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// `Ok` = a syntactically valid path still to be resolved against the
    /// vault; `Err` = a rejection already worded for the user.
    queue: Vec<Result<String, String>>,
    /// flipped by the first drain — i.e. the main window is mounted and
    /// listening, so later links can nudge it instead of only queueing
    main_ready: bool,
    capture_prefill: Option<String>,
}

#[derive(Default)]
pub(crate) struct DeepLinks(Mutex<Inner>);

impl DeepLinks {
    /// Hand over everything queued and mark the main window ready — the two
    /// are one step on purpose: a drain IS the window saying it can receive.
    pub(crate) fn take_pending(&self) -> Vec<Result<String, String>> {
        let mut g = self.0.lock().unwrap();
        g.main_ready = true;
        std::mem::take(&mut g.queue)
    }

    /// Read the pending capture prefill **without** consuming it. The capture
    /// window resets itself on more than one event (`tauri://focus` and
    /// `capture:prefill` both fire for the same link), and each reset clears
    /// the box before pulling — so a read that consumed would hand the text to
    /// whichever reset resolved first and leave the other one's clear as the
    /// last word: an empty box with the prefill already spent. A repeatable
    /// read makes the interleaving harmless; the prefill instead dies at a
    /// moment we control, `clear_capture_prefill`.
    pub(crate) fn capture_prefill(&self) -> Option<String> {
        self.0.lock().unwrap().capture_prefill.clone()
    }

    /// Drop the pending capture prefill. Called when the capture window is
    /// done with it — the note filed, or the window hidden — so the next
    /// hotkey capture opens empty rather than inheriting the last link's text.
    pub(crate) fn clear_capture_prefill(&self) {
        self.0.lock().unwrap().capture_prefill = None;
    }
}

/// Entry point for every URL the OS hands us, warm or cold.
pub(crate) fn handle_url(app: &tauri::AppHandle, raw: &str) {
    match parse(raw) {
        Ok(Action::Capture { text }) => {
            // `None` deliberately clears a stale prefill: a bare
            // substrate://capture must not resurrect the last link's text.
            app.state::<DeepLinks>().0.lock().unwrap().capture_prefill = text;
            show_capture(app);
            // a capture window that was already open and focused won't fire
            // `tauri://focus`, so tell it to pull directly too
            app.emit_to("capture", "capture:prefill", ()).ok();
        }
        Ok(Action::OpenNote(rel)) => queue_note(app, Ok(rel)),
        Err(msg) => queue_note(app, Err(msg)),
    }
}

fn queue_note(app: &tauri::AppHandle, item: Result<String, String>) {
    let ready = {
        let state = app.state::<DeepLinks>();
        let mut g = state.0.lock().unwrap();
        g.queue.push(item);
        g.main_ready
    };
    crate::show_main(app);
    if ready {
        app.emit("deeplink:pending", ()).ok();
    }
}

fn show_capture(app: &tauri::AppHandle) {
    let Some(w) = app.get_webview_window("capture") else {
        return;
    };
    // center() is a desktop-only method on WebviewWindow — the ios target has
    // no window placement, same gate main's toggle_capture path lives behind
    #[cfg(desktop)]
    w.center().ok();
    w.show().ok();
    w.set_focus().ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(url: &str) -> String {
        match parse(url) {
            Ok(Action::OpenNote(p)) => p,
            other => panic!("expected a note route, got {other:?}"),
        }
    }

    fn refused(url: &str) -> String {
        match parse(url) {
            Err(msg) => msg,
            other => panic!("expected a refusal for {url}, got {other:?}"),
        }
    }

    #[test]
    fn opens_a_plain_note() {
        assert_eq!(note("substrate://note/Inbox/Some%20note.md"), "Inbox/Some note.md");
        assert_eq!(note("substrate://note/Daily/2026-08-04.md"), "Daily/2026-08-04.md");
    }

    #[test]
    fn accepts_the_authority_less_spelling() {
        assert_eq!(note("substrate:note/Inbox/a.md"), "Inbox/a.md");
        assert_eq!(parse("substrate:capture"), Ok(Action::Capture { text: None }));
    }

    #[test]
    fn route_matching_ignores_case() {
        assert_eq!(note("SUBSTRATE://NOTE/a.md"), "a.md");
    }

    #[test]
    fn rejects_traversal_plain_and_encoded() {
        for u in [
            // literal `..` never survives Url::parse — these are caught by the
            // raw-text pre-check, before normalisation can rewrite them
            "substrate://note/../../../etc/passwd.md",
            "substrate://note/Inbox/../../secrets.md",
            "substrate:note/../secrets.md",
            // encoded `..` reaches the segment loop intact and dies there
            "substrate://note/%2e%2e%2f%2e%2e%2fsecrets.md",
            "substrate://note/%2E%2E/secrets.md",
            "substrate://note/Inbox/%2e%2e/x.md",
        ] {
            assert!(refused(u).contains("unsafe"), "{u} was not refused as unsafe");
        }
    }

    #[test]
    fn rejects_absolute_and_smuggled_separators() {
        for u in [
            "substrate://note//etc/passwd.md",
            "substrate://note/Inbox%2f%2e%2e%2fx.md",
            "substrate://note/C%3A%5CUsers%5Cx.md",
            "substrate://note/Inbox/.md/",
        ] {
            assert!(refused(u).contains("unsafe"), "{u} was not refused as unsafe");
        }
    }

    #[test]
    fn rejects_control_characters_and_bad_escapes() {
        assert!(refused("substrate://note/In%00box.md").contains("unsafe"));
        assert!(refused("substrate://note/a%2.md").contains("Bad escape"));
        // %ff is not valid UTF-8 on its own
        assert!(refused("substrate://note/a%ff.md").contains("Bad escape"));
    }

    #[test]
    fn rejects_non_markdown_and_empty_paths() {
        assert!(refused("substrate://note/Inbox/photo.png").contains("isn't one"));
        assert!(refused("substrate://note/").contains("needs a note path"));
        assert!(refused("substrate://note").contains("needs a note path"));
    }

    #[test]
    fn rejects_foreign_schemes_and_unknown_routes() {
        assert!(refused("https://example.com/note/a.md").contains("Not a Substrate link"));
        assert!(refused("substrate://wipe/everything").contains("doesn't know how to open"));
        assert!(refused("not a url at all").contains("Not a valid link"));
    }

    #[test]
    fn capture_takes_an_optional_prefill() {
        assert_eq!(parse("substrate://capture"), Ok(Action::Capture { text: None }));
        assert_eq!(
            parse("substrate://capture?text=call%20the%20studio"),
            Ok(Action::Capture {
                text: Some("call the studio".into())
            })
        );
        // blank and whitespace-only prefills open capture empty rather than failing
        assert_eq!(
            parse("substrate://capture?text=%20%20"),
            Ok(Action::Capture { text: None })
        );
        assert_eq!(
            parse("substrate://capture?other=x"),
            Ok(Action::Capture { text: None })
        );
    }

    #[test]
    fn capture_prefill_survives_repeated_reads_until_cleared() {
        let links = DeepLinks::default();
        links.0.lock().unwrap().capture_prefill = Some("call the studio".into());
        // the capture window resets (and so pulls) more than once per link —
        // every pull must see the same text, or one reset's clear wins
        assert_eq!(links.capture_prefill().as_deref(), Some("call the studio"));
        assert_eq!(links.capture_prefill().as_deref(), Some("call the studio"));
        links.clear_capture_prefill();
        assert_eq!(links.capture_prefill(), None);
    }

    #[test]
    fn capture_prefill_is_capped() {
        let long = "x".repeat(MAX_PREFILL * 2);
        let Ok(Action::Capture { text: Some(t) }) = parse(&format!("substrate://capture?text={long}"))
        else {
            panic!("expected a prefilled capture");
        };
        assert_eq!(t.chars().count(), MAX_PREFILL);
    }
}
